import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import type { OpenRouter } from '@openrouter/sdk';
import { ConfigService } from '../../../common/config.service';
import { delay } from '../../../common/util';
import { StatsService } from '../../../stats/stats.service';
import {
  buildHolidayGreetingPrompt,
  buildSelfSummaryPrompt,
  buildSystemResponsePrompt,
  buildUserProfilePrompt,
  formatGmt4Minute,
} from '../../application/ai-prompts';
import { ContextBuilderService, type ContextBuilder } from '../../application/context-builder.service';
import type { AiBrain, AnalysisResult, InteractionContext } from '../../domain/ports/ai-brain.port';
import { errorAnalysisResult, parseAnalysisJson } from '../mappers/gemini.mapper';

// ponytail: web_search two-pass es exclusivo de Gemini; OpenRouter sin web search por ahora.

const CHAT_SESSION = 'hakkurin-chat';
const MEM_SESSION = 'hakkurin-mem';
const RETRY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;

@Injectable()
export class OpenRouterAdapter implements AiBrain, OnModuleInit {
  private readonly logger = new Logger(OpenRouterAdapter.name);
  private client: OpenRouter | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(ContextBuilderService) private readonly context: ContextBuilder,
    private readonly stats: StatsService,
  ) {}

  // onModuleInit y no ctor: ConfigService aún no leyó config.json en el ctor.
  async onModuleInit(): Promise<void> {
    await this.config.load();
    await this.reloadConfig();
  }

  async reloadConfig(): Promise<void> {
    this.logger.log('Recargando configuración de OpenRouter...');
    this.client = null;
    await this.initialize();
  }

  private chatModel(): string {
    return this.config.get<string>('openrouter_chat_model', '');
  }

  // Sin modelo de memoria, la memoria viaja por el de chat (misma sesión no: sticky distinto).
  private memModel(): string {
    return this.config.get<string>('openrouter_memory_model', '') || this.chatModel();
  }

  // protected para que tests lo stubbeen sin tocar la red real.
  protected async loadSdk(): Promise<any> {
    // ponytail: TS en CJS baja este import() a require() — requiere Node >= 22.12 (require(esm), sin TLA en el SDK).
    return await import('@openrouter/sdk');
  }

  protected createClient(sdk: any, apiKey: string): OpenRouter {
    // El default del SDK reintenta 5XX hasta 1 hora: un outage colgaría la
    // respuesta del bot. Cap propio a 30s; el retry fino lo hace withRetry.
    return new sdk.OpenRouter({
      apiKey,
      timeoutMs: 120_000,
      retryConfig: {
        strategy: 'backoff',
        backoff: { initialInterval: 500, maxInterval: 8_000, exponent: 1.5, maxElapsedTime: 30_000 },
        retryConnectionErrors: true,
      },
    });
  }

  private async initialize(): Promise<void> {
    const apiKey = this.config.get<string>('openrouter_api_key', '');
    if (!apiKey) {
      this.logger.warn('No hay API key de OpenRouter configurada.');
      this.client = null;
      return;
    }
    try {
      const sdk = await this.loadSdk();
      this.client = this.createClient(sdk, apiKey);
      this.logger.log(`Cliente OpenRouter inicializado (chat: ${this.chatModel() || 'SIN MODELO'})`);
    } catch (e: any) {
      this.logger.warn(`Error inicializando OpenRouter: ${e.message}`);
      this.client = null;
    }
  }

  private async ensureClient(): Promise<boolean> {
    if (this.client) return true;
    await this.initialize();
    return this.client != null;
  }

  private async send(
    model: string,
    messages: any[],
    opts: { temperature: number; maxTokens: number; sessionId: string },
  ): Promise<string | null> {
    const chatRequest: any = {
      model,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      sessionId: opts.sessionId,
    };
    // El SDK serializa reasoning → "reasoning" en el body; el valor lo lee el
    // proveedor en caliente, así que cambiarlo en la WebUI no requiere reload.
    const effort = this.config.get<string>('openrouter_reasoning_effort', 'default');
    if (effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high') {
      chatRequest.reasoning = { effort };
    }
    // Caching explícito según proveedor: Anthropic acepta la directiva a nivel
    // raíz; Qwen (Alibaba) la exige por bloque (OpenAI/DeepSeek/Z.AI/Gemini son
    // automáticos y no necesitan nada).
    if (model.startsWith('anthropic/')) {
      chatRequest.cacheControl = { type: 'ephemeral' };
    } else if (model.includes('qwen')) {
      const first = messages[0];
      if (typeof first?.content === 'string') {
        first.content = [{ type: 'text', text: first.content, cacheControl: { type: 'ephemeral' } }];
      } else if (Array.isArray(first?.content) && first.content[0]?.type === 'text') {
        first.content[0].cacheControl = { type: 'ephemeral' };
      }
    }

    const res = await this.client!.chat.send({ chatRequest });
    if (!('choices' in res)) return null; // nunca pedimos stream
    const usage: any = (res as any).usage;
    if (usage) {
      const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
      this.stats.addTokens(usage.promptTokens ?? 0, usage.completionTokens ?? 0, cached, usage.cost ?? 0, model);
      if (cached > 0) this.logger.debug(`Prompt cache hit de OpenRouter: ${cached} tokens`);
    }

    const raw = res.choices?.[0]?.message?.content;
    let text: string | null = null;
    if (typeof raw === 'string') text = raw.trim();
    else if (Array.isArray(raw)) text = raw.map((p: any) => p?.text ?? '').join('').trim();
    return text || null;
  }

  private async withRetry(fn: () => Promise<string | null>): Promise<[string | null, any]> {
    let lastError: any = null;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      if (!(await this.ensureClient())) return [null, new Error('sin API key de OpenRouter')];
      try {
        const text = await fn();
        if (text === null) lastError = new Error('respuesta vacía');
        else return [text, null];
      } catch (e: any) {
        lastError = e;
        this.logger.warn(`OpenRouter intento ${attempt + 1}/${RETRY_ATTEMPTS} falló: ${e.message}`);
      }
      if (attempt < RETRY_ATTEMPTS - 1) await delay(RETRY_DELAY_MS);
    }
    this.logger.warn(`Fallaron todos los intentos de OpenRouter: ${lastError?.message ?? lastError}`);
    return [null, lastError];
  }

  private requireModel(kind: 'chat' | 'mem'): string | null {
    const model = kind === 'chat' ? this.chatModel() : this.memModel();
    if (!model) this.logger.warn(`Sin modelo de ${kind} de OpenRouter configurado; degradando como no configurado.`);
    return model || null;
  }

  async analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult> {
    const model = this.requireModel('chat');
    if (!model) return errorAnalysisResult('OpenRouter sin modelo de chat configurado');

    const { prompt, imageData, imageMime } = await this.context.buildInteractionPrompt(ctx);
    const content: any[] = [{ type: 'text', text: prompt }];
    if (imageData && imageMime) {
      content.push({
        type: 'image_url',
        imageUrl: { url: `data:${imageMime};base64,${Buffer.from(imageData).toString('base64')}` },
      });
    }

    const [raw, err] = await this.withRetry(() =>
      this.send(model, [{ role: 'user', content }], { temperature: 0.85, maxTokens: 800, sessionId: CHAT_SESSION }),
    );
    // El intent 'error' dispara el sueño de emergencia en smart-response: nunca lanzar.
    if (raw === null) return errorAnalysisResult(err?.message ?? 'error desconocido');
    return parseAnalysisJson(raw);
  }

  async generateResponse(
    prompt: string,
    userContextId = 'hakkurin_internal_self',
    userName = 'Sistema',
  ): Promise<string | null> {
    const model = this.requireModel('chat');
    if (!model) return null;
    const full = buildSystemResponsePrompt(prompt, userContextId, userName);
    const [text] = await this.withRetry(() =>
      this.send(model, [{ role: 'user', content: full }], {
        temperature: 0.85,
        maxTokens: 600,
        sessionId: CHAT_SESSION,
      }),
    );
    return text;
  }

  async generateSummary(
    currentSummary: string,
    recentInteractions: string[],
    userId: string,
  ): Promise<string | null> {
    const model = this.requireModel('mem');
    if (!model) return null;

    const prompt =
      userId === 'hakkurin_internal_self'
        ? buildSelfSummaryPrompt(currentSummary, recentInteractions, formatGmt4Minute(new Date()))
        : buildUserProfilePrompt(userId, currentSummary, recentInteractions);

    const [text] = await this.withRetry(() =>
      this.send(model, [{ role: 'user', content: prompt }], {
        temperature: 0.85,
        maxTokens: 600,
        sessionId: MEM_SESSION,
      }),
    );
    return text;
  }

  async generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string> {
    const model = this.requireModel('chat');
    if (!model) return `feliz ${holidayName} supongo...`;
    const prompt = buildHolidayGreetingPrompt(userSummary, holidayName);
    const [text] = await this.withRetry(() =>
      this.send(model, [{ role: 'user', content: prompt }], {
        temperature: 0.9,
        maxTokens: 300,
        sessionId: CHAT_SESSION,
      }),
    );
    return text || `feliz ${holidayName} supongo...`;
  }

  async testApiConnection(): Promise<boolean> {
    const model = this.requireModel('chat');
    if (!model) return false;
    const [text] = await this.withRetry(() =>
      this.send(model, [{ role: 'user', content: 'ping' }], {
        temperature: 0,
        maxTokens: 5,
        sessionId: CHAT_SESSION,
      }),
    );
    return text != null;
  }
}
