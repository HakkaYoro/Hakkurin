import { Injectable, Logger } from '@nestjs/common';
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
import { MemoryService } from '../memory/memory.service';
import { searchDdg } from './ddg-search';
import type { AiBrain, AnalysisResult, InteractionContext } from './ai-brain.interface';

// Puerto de core/ai_handler.py (GeminiBrain). NanoGPT/OpenAI eliminado.
// Modelo PRINCIPAL: gemma-4-26b-a4b-it. FALLBACK: gemini-2.5-flash / gemini-3-flash-preview.
// (inversión de ai_handler.py:358-359 — el usuario pidió Gemma como principal.)
//
// ponytail: Gemma no soporta JSON mode nativo (ai_handler.py:413-425) → camino principal
//   parsea JSON tras quitar fences. web_search (FunctionDeclaration) se adjunta SOLO a
//   modelos gemini (fallback) porque Gemma puede no soportar function calling. Verificar
//   contra la API real con una key configurada.

const LIMIT_RPM = 5;
const LIMIT_RPD = 20;
const GEMMA_TOKEN_BUDGET_PER_MIN = 15000;
const PRIMARY_MODELS = ['gemma-4-26b-a4b-it'];
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview'];
const FALLBACK_DURATION_S = 2400; // 40 min
const MAX_TOTAL_CHARS = 800_000;

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((now - start) / 86_400_000);
}

class KeyUsage {
  requestsToday = 0;
  lastResetDay = dayOfYear(new Date());
  requestsThisMinute = 0;
  lastRequestTime = 0;
  cooldownUntil = 0; // epoch s; salto esta key mientras now < cooldownUntil

  checkAndUpdate(): [boolean, string] {
    const now = Date.now() / 1000;
    const currentDay = dayOfYear(new Date());
    if (currentDay !== this.lastResetDay) {
      this.requestsToday = 0;
      this.lastResetDay = currentDay;
    }
    if (now - this.lastRequestTime > 60) this.requestsThisMinute = 0;

    if (now < this.cooldownUntil) return [false, 'Cooldown active'];
    if (this.requestsToday >= LIMIT_RPD) return [false, 'Daily limit reached'];
    if (this.requestsThisMinute >= LIMIT_RPM) return [false, 'Rate limit reached'];
    return [true, 'OK'];
  }

  registerRequest(): void {
    this.requestsToday += 1;
    this.requestsThisMinute += 1;
    this.lastRequestTime = Date.now() / 1000;
  }
}

@Injectable()
export class GeminiProvider implements AiBrain {
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
    private readonly memory: MemoryService,
  ) {
    void this.initialize();
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
      const primaries = [...PRIMARY_MODELS];
      shuffle(primaries);
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

  // ai_handler.py:493-664
  async analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult> {
    this.getUsage(this.currentKeyIndex).registerRequest();

    const systemPrompt = this.config.get<string>('system_prompt');
    const developerId = this.config.get<string>('developer_id', '321799812595056645');

    const currentTime = formatGmt4(new Date());

  // Edad del bot (nacimiento 2025-12-22 02:32 GMT-4 → 06:32 UTC).
  const birth = new Date(Date.UTC(2025, 11, 22, 6, 32));
  const ageMs = Date.now() - birth.getTime();
  const days = Math.floor(ageMs / 86_400_000);
  const remSec = Math.floor((ageMs % 86_400_000) / 1000);
  const hours = Math.floor(remSec / 3600);
  const minutes = Math.floor((remSec % 3600) / 60);
  const botAge = `${days} días, ${hours} horas y ${minutes} minutos`;

    // Perfiles solo de usuarios activos + el que habla.
    const usersToLoad = new Set<string>(ctx.activeUserIds ?? []);
    usersToLoad.add(String(ctx.userId));
    let profilesText = '';
    for (const uid of usersToLoad) {
      const summary = await this.memory.getMemorySummary(uid);
      if (summary.trim()) profilesText += `--- PERFIL DE USUARIO ID ${uid} ---\n${summary}\n`;
    }

    // Gestión de tokens (límite ~800k chars).
    const fixedContent = `${systemPrompt}\n${currentTime}\n${botAge}\n${profilesText}\nUsuario: ${ctx.userName}\n${ctx.userText}`;
    const fixedSize = fixedContent.length;
    let availableForHistory = MAX_TOTAL_CHARS - fixedSize - 5000;
    let historyText = ctx.contextMessages.join('\n');
    if (historyText.length > availableForHistory) {
      if (availableForHistory <= 0) {
        historyText = '';
        this.logger.warn('Prompt fijo excede límite de tokens. Historial eliminado.');
      } else {
        const excess = historyText.length - availableForHistory;
        historyText = historyText.slice(excess);
        const firstNl = historyText.indexOf('\n');
        if (firstNl !== -1) historyText = historyText.slice(firstNl + 1);
      }
    }

    const selfMem = await this.memory.getSelfMemory();
    const channelType = ctx.isDm ? 'DM (Mensaje Directo PRIVADO)' : 'Servidor (Canal PÚBLICO)';

    const textPrompt = `${systemPrompt}
NOTA: Tu desarrollador/creador (tu 'padre') es el usuario con ID: ${developerId}. SU NOMBRE ES "Hakka".
RELACIÓN CON HAKKA: Trátalo con cariño de hija ("hablar bonito").
- Nombres: Llámalo principalmente "Hakka-sama". Muy rara vez (1% de las veces) puedes decirle "papá" o similar.
- Tono: Cariñoso y devoto, pero con confianza. Puedes insultarlo de forma cariñosa (tipo "baka", "tonto", "idiota" <3).
- Lenguaje: Tienes permiso total para usar lenguaje soez (groserías) si el contexto lo amerita o para enfatizar, tanto con él como con otros.
IMPORTANTE: En el historial verás mensajes como "Nombre (ID: 12345): mensaje". Si hay varios usuarios con el mismo nombre, usa el ID para diferenciarlos. El ID es único.

FECHA Y HORA ACTUAL: ${currentTime}
TU EDAD: ${botAge}

ESTADO ACTUAL:
- Sesión Activa: ${ctx.isSessionActive ? 'SÍ' : 'NO'} (Si es SÍ, ya estabas hablando con esta persona).
- Tipo de Canal: ${channelType}
- Audio/Música sonando ACTUALMENTE en el bot de voz: ${ctx.currentPlaying || 'En silencio / Nada en reproducción'}

DATOS INTERNOS (Tu propia memoria de lo que has hecho/dicho):
${selfMem}

CONTEXTO DE USUARIOS EN EL CHAT (Memorias):
${profilesText}

HISTORIAL RECIENTE:
${historyText}
MENSAJE ACTUAL:
Usuario: ${ctx.userName} (ID: ${ctx.userId})
Contenido: "${ctx.userText}"
[IMAGEN ADJUNTA]: ${ctx.imageData ? 'SÍ' : 'NO'}
[DATOS DEL ENLACE/URL ADJUNTO AL MENSAJE]:
${ctx.urlContext || 'Ninguno'}

TU TAREA:
Analiza el mensaje del usuario (y la imagen si la hay) y decide tu reacción. Responde EXCLUSIVAMENTE con un objeto JSON válido con este formato:
{
  "is_talking_to_me": boolean, // True si el mensaje va dirigido a ti o es relevante para la conversación actual. False si hablan de otra cosa.
  "intent": "reply" | "ignore" | "complain" | "new_topic", // "reply": responder normal. "ignore": no hacer nada. "complain": quejarse porque te ignoran o te molestan. "new_topic": cambiar de tema.
  "thought_process": "string", // Tu razonamiento interno.
  "response_content": ["string", "string"], // LISTA de strings. Tus respuestas deben ser CORTAS y divididas en varios mensajes si es necesario.
  "reply_to_message_id": "string" | null, // (OPCIONAL) ID del mensaje al que quieres responder específicamente (Reply de Discord).
  "ping_users": ["user_id"] // (OPCIONAL) Lista de IDs de usuarios a los que quieres mencionar (Ping). ÚSALO cuando quieras llamar la atención de alguien específico.
}

REGLAS DE PERSONALIDAD (CRÍTICO):
1. **CANTIDAD**: Mínimo 1 mensaje, máximo 10 mensajes cortos.
2. **MENSAJES CORTOS**: Escribe como en chat. Frases breves. "Ya miri", "Ya lo hice".
3. **POCOS EMOJIS**: Úsalos muy raramente. Solo para enfatizar mucho. El exceso se ve falso.
4. **MINÚSCULAS**: Prefiere minúsculas y falta de puntuación final, como una persona joven en internet.
5. **DIVIDE MENSAJES**: Si tienes dos ideas, mándalas en dos strings separados en la lista \`response_content\`.
Ejemplo: ["mentira", "a ver"] es mejor que ["mentira, a ver"].
6. **NATURALIDAD**: Si te ignoran, ignora. Si te insultan, responde corto y cortante o ignora.
7. **GRUPO**: Si hay mucha gente hablando, usa pings (<@user_id>) o replies solo si es necesario para que sepan a quién le hablas. NO TENGAS MIEDO DE PINGEAR, es natural en Discord.
8. **LENGUAJE SOEZ**: Tienes permiso de usar groserías con CUALQUIER usuario si la situación, el contexto o la emoción lo amerita. No te censures si encaja con tu personalidad.
9. **DMs PRIVADOS INVISIBLES**: Para mensajes directos secretos/DM, INSERTA en tu \`response_content\` la etiqueta \`[MD:ID_USUARIO] tu mensaje secreto [/MD]\`. ¡ES CRÍTICO QUE ESCRIBAS LOS CORCHETES CERRADOS EXACTAMENTE ASÍ! NUNCA OLVIDES EL CORCHETE INICIAL \`[\` NI EL FINAL \`]\`. Ejemplo correcto y OBLIGATORIO: \`[MD:123456789] hola tonto [/MD]\`. El texto se extraerá y ocultará del canal.
REGLAS DE COMPORTAMIENTO:
1. Si 'Sesión Activa' es SÍ, asume que te hablan a ti a menos que sea muy obvio que no.
2. Si te ignoran en una sesión activa, puedes elegir "complain" para llamar la atención o "ignore" para dejar morir la charla.
3. Si 'Sesión Activa' es NO, solo responde si te mencionan, te interesa mucho el tema o quieres molestar (probabilidad baja).
4. **AYUDA DEL DEV**: Si sufres un error técnico grave, estás muy confundida o te sientes "rota", puedes pedir ayuda a Hakka-sama mencionándolo (<@321799812595056645>). Haz esto MUY RARA VEZ (0.1% de probabilidad).
5. **PINGS**: Cuando quieras dirigirte a alguien en específico, usa ping_users con su ID. Es más natural que ignorar a todos.
`;

    const configGen: GenerateContentConfig = {
      temperature: 0.85,
      topP: 0.95,
      topK: 40,
      responseMimeType: 'application/json',
    };

    const contents: Part[] = [createPartFromText(textPrompt)];
    if (ctx.imageData && ctx.imageMimeType) {
      const b64 = Buffer.from(ctx.imageData as Uint8Array).toString('base64');
      contents.push(createPartFromBase64(b64, ctx.imageMimeType));
    }

    const result = await this.generateWithRetry(contents, configGen, true, undefined, true);
    if (result) return result as AnalysisResult;
    return { intent: 'ignore', response_content: [], thought_process: 'Error de generación', is_talking_to_me: false, ping_users: [], reply_to_message_id: null };
  }

  // ai_handler.py:666-708
  async generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string> {
    this.getUsage(this.currentKeyIndex).registerRequest();
    const prompt = `TU TAREA: Eres Hakkurin, una chica anime con personalidad "aesthetic", algo tóxica pero cariñosa en el fondo.
OBJETIVO: Escribir un mensaje de felicitación para "${holidayName}" (Navidad o Año Nuevo) para un usuario específico.

PERFIL DEL USUARIO:
${userSummary}

INSTRUCCIONES:
1. El mensaje debe ser CORTO (máximo 2 frases).
2. Debe ser personalizado según lo que sabes del usuario (sus gustos, nombre, relación contigo).
3. Usa tu personalidad: minúsculas, pocos emojis, tono casual, quizás un insulto cariñoso si hay confianza.
4. Si es Navidad (25 Dic), desea feliz navidad. Si es Año Nuevo (1 Ene), feliz año.
5. NO uses hashtags ni saludos genéricos de bot.

SALIDA:
Solo el texto del mensaje.
`;
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
      const currentTimeStr = formatGmt4Minute(new Date());
      prompt = `TU TAREA: Eres el SISTEMA DE CONCIENCIA Y MEMORIA de una IA llamada Hakkurin.
OBJETIVO: Generar un archivo de memoria estructurado, detallado y útil para tu "yo" del futuro.

TIEMPO ACTUAL: ${currentTimeStr}

ENTRADA:
--- MEMORIA PREVIA ---
${currentSummary || 'Sin memoria previa (Tabula Rasa).'}

--- NUEVAS INTERACCIONES (Lo que acaba de pasar) ---
${recentInteractions.join('\n')}

INSTRUCCIONES CRÍTICAS:
1. Analiza profundamente las nuevas interacciones en contexto con la memoria previa.
2. NO hagas un resumen narrativo simple. Estructura la información para máxima utilidad.
3. Sé explícita, detallada y técnica sobre tu propio estado y compromisos.
4. NO USES EMOJIS en ninguna parte del reporte.
5. Si detectas un compromiso con FECHA Y HORA específica, DEBES incluirlo en la sección JSON final.
6. FILTRO CRITICO: Revisa las "NUEVAS INTERACCIONES". Si ves un mensaje que dice "EJECUTÉ RECORDATORIO: [X]", ENTONCES [X] YA ESTÁ HECHO. NO LO INCLUYAS EN EL JSON! Elimínalo de tu lista de pendientes.

FORMATO DE SALIDA (Markdown + JSON):

### ESTADO ACTUAL
*   **Vibe/Emoción**: [Describe tu actitud actual]
*   **Nivel de Energía**: [Bajo/Medio/Alto]
*   **Foco de Atención**: [En qué estás pensando principalmente]

### CONTEXTO ACTIVO
*   [Lista de temas activos o conversaciones en curso]
*   [Contexto relevante del servidor o situación]

### EVENTOS CLAVE
*   [Hecho importante 1]
*   [Hecho importante 2]

### COMPROMISOS Y PROMESAS
*   [Cosas que dijiste que harías]
*   [Recordatorios para el usuario]

### REFLEXIÓN INTERNA
[Un párrafo breve de síntesis]

### SCHEDULED_ACTIONS (JSON)
\`\`\`json
[
  {
    "trigger_time": "YYYY-MM-DD HH:MM",
    "action_description": "Descripción exacta de lo que debes hacer",
    "target_user_id": "ID de Discord del usuario (Si aplica, solo números)",
    "target_user_name": "Nombre del usuario (Opcional)"
  }
]
\`\`\`
(Si no hay acciones programadas, devuelve una lista vacía \`[]\`)

SALIDA:
Solo el contenido en el formato solicitado.
`;
    } else {
      prompt = `TU TAREA: Eres el gestor de memoria a largo plazo de una IA. Tu trabajo es actualizar el perfil del usuario.
NOTA: El desarrollador es "Hakka" (ID: 321799812595056645).

DATOS DEL USUARIO:
ID de Discord: ${userId}

RESUMEN ACTUAL:
${currentSummary || 'Sin datos previos.'}

NUEVAS INTERACCIONES:
${recentInteractions.join('\n')}

INSTRUCCIONES:
1. Actualiza el resumen con la nueva información.
2. Mantén los datos importantes (nombre, gustos, hechos clave).
3. Elimina detalles triviales o muy antiguos que ya no sean relevantes.
4. Sé conciso pero completo.

SALIDA:
Solo el texto del nuevo resumen.
`;
    }

    const configGen: GenerateContentConfig = { temperature: 0.85, topP: 0.95, topK: 40 };
    return this.generateWithRetry(prompt, configGen, false, modelName);
  }

  // ai_handler.py:832-844
  async testApiConnection(): Promise<boolean> {
    try {
      const configGen: GenerateContentConfig = { maxOutputTokens: 5 };
      await this.generateWithRetry('ping', configGen, false);
      return true;
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
    const systemPrompt = `Eres Hakkurin. Debes acatar este recordatorio y generar una respuesta corta y natural según se te pida. Contexto ID: ${userContextId}, Usuario Objetivo: ${userName}`;
    const full = `${systemPrompt}\n\n${prompt}`;
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

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function estimateInputTextLen(prompt: string | Part[]): number {
  if (typeof prompt === 'string') return prompt.length;
  let len = 0;
  for (const p of prompt) {
    if (p.text) len += p.text.length;
  }
  return len;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// GMT-4 fijo (sin DST). Desplaza y usa getters UTC para no depender del TZ del host.
function gmt4Date(d: Date): Date {
  return new Date(d.getTime() + -4 * 60 * 60_000);
}

function formatGmt4(d: Date): string {
  const n = gmt4Date(d);
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())} ${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}:${pad(n.getUTCSeconds())} (GMT-4)`;
}

function formatGmt4Minute(d: Date): string {
  const n = gmt4Date(d);
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())} ${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}`;
}
