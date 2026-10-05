import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import {
  GoogleGenAI,
  Type,
  createPartFromBase64,
  createPartFromText,
  type FunctionDeclaration,
  type Part,
  type GenerateContentConfig,
} from '@google/genai';
import { ConfigService } from '../common/config.service';
import { searchDdg } from './ddg-search';
import { shuffle as shuffleArr } from '../common/util';
import { KeyUsage } from './key-rotation';
import {
  buildHolidayGreetingPrompt,
  buildSelfSummaryPrompt,
  buildSystemResponsePrompt,
  buildUserProfilePrompt,
  formatGmt4Minute,
} from './ai-prompts';
import { ContextBuilderService, type ContextBuilder } from './context-builder.service';
import type { AiBrain, AnalysisResult, InteractionContext } from './ai-brain.interface';

// Motor del cerebro (puerto de core/ai_handler.py, GeminiBrain). NanoGPT/OpenAI eliminado.
// Modelo PRINCIPAL: gemma-4-26b-a4b-it. FALLBACK: gemini-2.5-flash / gemini-3-flash-preview.
// (inversión de ai_handler.py:358-359 — el usuario pidió Gemma como principal.)
//
// El contenido (prompts) vive en ai-prompts.ts; el armado del contexto de interacción
// (perfiles/historial/imagen) en context-builder.service.ts. Aquí queda el motor:
// rotación de keys, retry por modelo, two-pass web_search y parseo de fences.
//
// ponytail: Gemma no soporta JSON mode nativo (ai_handler.py:413-425) → camino principal
//   parsea JSON tras quitar fences. web_search (FunctionDeclaration) se adjunta SOLO a
//   modelos gemini (fallback) porque Gemma puede no soportar function calling. Verificar
//   contra la API real con una key configurada.

const GEMMA_TOKEN_BUDGET_PER_MIN = 15000;
const PRIMARY_MODELS = ['gemma-4-26b-a4b-it'];
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview'];
const FALLBACK_DURATION_S = 2400; // 40 min

@Injectable()
export class GeminiProvider implements AiBrain, OnModuleInit {
  private readonly logger = new Logger(GeminiProvider.name);
  private keys: string[] = [];
  private currentKeyIndex = 0;
  private client: GoogleGenAI | null = null;
  private keyUsage = new Map<number, KeyUsage>();
  private fallbackUntil = 0;
  private gemmaTokensThisMinute = 0;
  private gemmaLastReset = 0;

  constructor(
    private readonly config: ConfigService,
    @Inject(ContextBuilderService) private readonly context: ContextBuilder,
  ) {}

  // Carga las keys tras la inicialización del módulo (no en el ctor): el ctor
  // corría ANTES de que ConfigService terminara de leer data/config.json, así que
  // this.keys quedaba [] y el cliente nunca se creaba hasta un POST /restart.
  // Await config.load() garantiza que el JSON ya está en memoria.
  async onModuleInit(): Promise<void> {
    await this.config.load();
    await this.reloadConfig();
  }

  async reloadConfig(): Promise<void> {
    this.logger.log('Recargando configuración de GeminiBrain...');
    this.keys = this.config.get<string[]>('gemini_keys', []) ?? [];
    this.currentKeyIndex = 0;
    this.client = null;
    await this.initialize();
  }

  private getUsage(index: number): KeyUsage {
    if (!this.keyUsage.has(index)) this.keyUsage.set(index, new KeyUsage());
    return this.keyUsage.get(index)!;
  }

  // protected para que tests lo stubbeen sin tocar la red real.
  protected createClient(apiKey: string): GoogleGenAI {
    return new GoogleGenAI({ apiKey });
  }

  private async initialize(): Promise<void> {
    if (!this.keys.length) {
      this.logger.warn('No hay API Keys de Gemini configuradas.');
      return;
    }
    let attempts = 0;
    while (attempts < this.keys.length) {
      const usage = this.getUsage(this.currentKeyIndex);
      const [canUse, reason] = usage.checkAndUpdate();
      if (canUse) {
        try {
          this.client = this.createClient(this.keys[this.currentKeyIndex]);
          this.logger.log(`Cliente Gemini inicializado con llave ${this.currentKeyIndex}`);
          return;
        } catch (e: any) {
          this.logger.warn(`Error init key ${this.currentKeyIndex}: ${e.message}`);
        }
      } else {
        this.logger.log(`Key ${this.currentKeyIndex} agotada (${reason}). Rotando...`);
      }
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
      attempts += 1;
    }
    this.logger.error('ERROR CRÍTICO: Todas las keys están agotadas o fallando.');
    this.client = null;
  }

  private async rotateKey(): Promise<void> {
    if (!this.keys.length) return;
    this.logger.log(`Rotando API Key desde ${this.currentKeyIndex}...`);
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
    await this.initialize();
  }

  private checkGemmaLimit(estimatedTokens: number): boolean {
    const now = Date.now() / 1000;
    if (now - this.gemmaLastReset > 60) {
      this.gemmaTokensThisMinute = 0;
      this.gemmaLastReset = now;
    }
    return this.gemmaTokensThisMinute + estimatedTokens <= GEMMA_TOKEN_BUDGET_PER_MIN;
  }

  private updateGemmaUsage(tokens: number): void {
    this.gemmaTokensThisMinute += tokens;
  }

  // ai_handler.py:352-491
  private async generateWithRetry(
    prompt: string | Part[],
    baseConfig: GenerateContentConfig,
    isJson = false,
    forceModel?: string,
    enableSearch = false,
  ): Promise<any> {
    const now = Date.now() / 1000;
    let useFallback = false;
    let modelsToTry: string[];

    if (forceModel) {
      modelsToTry = [forceModel];
    } else if (now < this.fallbackUntil) {
      modelsToTry = [...FALLBACK_MODELS];
      useFallback = true;
    } else {
      const primaries = shuffleArr([...PRIMARY_MODELS]);
      modelsToTry = [...primaries, ...FALLBACK_MODELS];
    }

    let lastError: any = null;

    for (const modelName of modelsToTry) {
      const isGemma = modelName.includes('gemma');

      if (isGemma) {
        const inputTextLen = estimateInputTextLen(prompt);
        const estimated = Math.floor(inputTextLen / 4);
        if (!this.checkGemmaLimit(estimated)) {
          this.logger.log(`Límite de tokens de Gemma excedido (${this.gemmaTokensThisMinute}/${GEMMA_TOKEN_BUDGET_PER_MIN}). Saltando modelo.`);
          continue;
        }
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.client) {
          await this.initialize();
          if (!this.client) return null;
        }

        try {
          // Gemma no soporta JSON mode → desactivar responseMimeType.
          const currentConfig: GenerateContentConfig = isGemma && isJson
            ? { ...baseConfig, responseMimeType: undefined }
            : baseConfig;

          // web_search solo en modelos gemini (Gemma puede no soportar FC).
          if (enableSearch && !isGemma) {
            currentConfig.tools = [{ functionDeclarations: [WEB_SEARCH_DECL] }];
          } else {
            delete currentConfig.tools;
          }

          let response = await this.client.models.generateContent({
            model: modelName,
            contents: prompt,
            config: currentConfig,
          });

          // Two-pass: si el modelo pidió web_search, ejecutar y re-llamar.
          const fcs = response.functionCalls;
          if (enableSearch && !isGemma && fcs && fcs.length) {
            const toolParts: Part[] = [];
            for (const fc of fcs) {
              if (fc.name === 'web_search') {
                const q = String(fc.args?.query ?? '');
                this.logger.log(`🛠️ web_search('${q}')`);
                const result = await searchDdg(q);
                toolParts.push({
                  functionResponse: { name: 'web_search', response: { result } },
                });
              }
            }
            if (toolParts.length) {
              // Convención de function-calling de Gemini: [user, model-fc, fn-response].
              const userParts = Array.isArray(prompt) ? prompt : [createPartFromText(String(prompt))];
              const modelParts = response.candidates?.[0]?.content?.parts ?? [];
              const secondConfig = { ...currentConfig };
              delete secondConfig.tools;
              response = await this.client.models.generateContent({
                model: modelName,
                contents: [
                  { role: 'user', parts: userParts },
                  { role: 'model', parts: modelParts },
                  { role: 'user', parts: toolParts },
                ],
                config: secondConfig,
              });
            }
          }

          let text = (response.text ?? '').trim();
          if (!text) {
            this.logger.warn(`RESPUESTA VACÍA con ${modelName}.`);
            try {
              this.logger.debug(`finish_reason: ${response.candidates?.[0]?.finishReason}`);
            } catch {}
          }

          // Éxito con fallback sin estar forzado → activar modo fallback 40 min.
          if (FALLBACK_MODELS.includes(modelName) && !useFallback) {
            this.logger.log('Primarios fallaron, activando Modo Fallback por 40 minutos.');
            this.fallbackUntil = Date.now() / 1000 + FALLBACK_DURATION_S;
          }

          if (isGemma) {
            const outTokens = Math.floor(text.length / 4);
            this.updateGemmaUsage(Math.floor(estimateInputTextLen(prompt) / 4) + outTokens);
          }

          if (isJson) {
            if (text.startsWith('```')) {
              text = text.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
            }
            return JSON.parse(text);
          }
          return text;
        } catch (e: any) {
          lastError = e;
          const errStr = String(e.message ?? e).toLowerCase();
          const isQuota = errStr.includes('429') || errStr.includes('quota') || errStr.includes('resource_exhausted');
          const isNotFound = errStr.includes('404') || errStr.includes('not found');
          this.logger.warn(`Error con ${modelName}: ${e.message}`);
          if (isQuota) {
            this.getUsage(this.currentKeyIndex).cooldownUntil = Date.now() / 1000 + 60;
            await this.rotateKey();
            continue;
          } else if (isNotFound) {
            break;
          } else {
            break;
          }
        }
      }
    }

    this.logger.warn(`Fallaron todos los intentos. Último error: ${lastError?.message ?? lastError}`);
    if (isJson) {
      return {
        intent: 'error' as const,
        response_content: [`Error crítico de IA: ${lastError?.message ?? lastError}`],
        is_talking_to_me: false,
        ping_users: [],
        reply_to_message_id: null,
        thought_process: 'Error de generación',
      };
    }
    return null;
  }

  // ai_handler.py:493-664 — el prompt y la imagen vienen del puerto ContextBuilder.
  async analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult> {
    this.getUsage(this.currentKeyIndex).registerRequest();

    const { prompt: textPrompt, imageData, imageMime } = await this.context.buildInteractionPrompt(ctx);

    const configGen: GenerateContentConfig = {
      temperature: 0.85,
      topP: 0.95,
      topK: 40,
      responseMimeType: 'application/json',
    };

    const contents: Part[] = [createPartFromText(textPrompt)];
    if (imageData && imageMime) {
      contents.push(createPartFromBase64(imageData.toString('base64'), imageMime));
    }

    const result = await this.generateWithRetry(contents, configGen, true, undefined, true);
    if (result) return result as AnalysisResult;
    return { intent: 'ignore', response_content: [], thought_process: 'Error de generación', is_talking_to_me: false, ping_users: [], reply_to_message_id: null };
  }

  // ai_handler.py:666-708
  async generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string> {
    this.getUsage(this.currentKeyIndex).registerRequest();
    const prompt = buildHolidayGreetingPrompt(userSummary, holidayName);
    const configGen: GenerateContentConfig = { temperature: 0.9, topP: 0.95, topK: 40 };
    const result = await this.generateWithRetry(prompt, configGen, false);
    return result || `feliz ${holidayName} supongo...`;
  }

  // ai_handler.py:710-830
  async generateSummary(
    currentSummary: string,
    recentInteractions: string[],
    userId: string,
    modelName?: string,
  ): Promise<string | null> {
    this.getUsage(this.currentKeyIndex).registerRequest();

    let prompt: string;
    if (userId === 'hakkurin_internal_self') {
      prompt = buildSelfSummaryPrompt(currentSummary, recentInteractions, formatGmt4Minute(new Date()));
    } else {
      prompt = buildUserProfilePrompt(userId, currentSummary, recentInteractions);
    }

    const configGen: GenerateContentConfig = { temperature: 0.85, topP: 0.95, topK: 40 };
    return this.generateWithRetry(prompt, configGen, false, modelName);
  }

  // ai_handler.py:832-844
  async testApiConnection(): Promise<boolean> {
    // Sin keys no hay API que testear (evita además el warn "No hay API Keys" cada
    // 60s desde recoveryProbe). El bug anterior: devolvía true siempre, incluso
    // cuando generateWithRetry retornaba null (no lanza) → recoveryProbe creía la
    // API sana. Ahora false si no hubo respuesta real.
    if (!this.keys.length) return false;
    try {
      const configGen: GenerateContentConfig = { maxOutputTokens: 5 };
      const result = await this.generateWithRetry('ping', configGen, false);
      return result != null;
    } catch (e: any) {
      this.logger.warn(`Test de API fallido: ${e.message}`);
      return false;
    }
  }

  // ai_handler.py:846-853 — antes NanoGPT-only; ahora Gemini.
  async generateResponse(
    prompt: string,
    userContextId = 'hakkurin_internal_self',
    userName = 'Sistema',
  ): Promise<string | null> {
    const full = buildSystemResponsePrompt(prompt, userContextId, userName);
    const configGen: GenerateContentConfig = { temperature: 0.85, topP: 0.95, topK: 40 };
    return this.generateWithRetry(full, configGen, false);
  }
}

const WEB_SEARCH_DECL: FunctionDeclaration = {
  name: 'web_search',
  description: 'Busca información en internet. Úsalo para noticias, precios, clima o datos recientes.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'La consulta de búsqueda optimizada para un buscador.' },
    },
    required: ['query'],
  },
};

function estimateInputTextLen(prompt: string | Part[]): number {
  if (typeof prompt === 'string') return prompt.length;
  let len = 0;
  for (const p of prompt) {
    if (p.text) len += p.text.length;
  }
  return len;
}
