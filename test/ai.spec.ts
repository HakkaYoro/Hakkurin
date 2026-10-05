import { vi } from 'vitest';
import { GeminiAdapter, PRIMARY_MODELS } from '../src/ai/infrastructure/adapters/gemini.adapter';
import { parseAnalysisJson, errorAnalysisResult } from '../src/ai/infrastructure/mappers/gemini.mapper';
import { ConfigService } from '../src/common/config.service';
import type { InteractionContext } from '../src/ai/domain/ports/ai-brain.port';

// Verificación conductual del contrato AiBrain con un client @google/genai mockeado.
// Complementa el review estático. No toca la red.

class MockConfig extends ConfigService {
  private store: Record<string, any> = {
    gemini_keys: ['key-0', 'key-1'],
    system_prompt: 'sys',
    bot_name: 'Hakkurin',
    developer_id: '321799812595056645',
  };
  // Sin IO de archivos — puramente en memoria (evita la race del .tmp entre instancias).
  async load(): Promise<void> {}
  async save(): Promise<void> {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeProvider(generateContent: any): GeminiAdapter {
  const config = new MockConfig();
  (config as any).store.gemini_keys = []; // evita construcción de cliente real en el ctor
  // Fake del puerto ContextBuilder (el provider ya no conoce MemoryService).
  const context = {
    buildInteractionPrompt: async (ctx: any) => ({
      prompt: 'PROMPT',
      imageData: ctx.imageData ?? null,
      imageMime: ctx.imageMimeType ?? null,
    }),
  };
  const provider = new GeminiAdapter(config, context);
  // stub del factory de cliente: toda rotación crea un mock que usa el mismo generateContent.
  (provider as any).createClient = () => ({ models: { generateContent } });
  (provider as any).keys = ['key-0', 'key-1'];
  return provider;
}

function ctx(over: Partial<InteractionContext> = {}): InteractionContext {
  return {
    userText: 'hola',
    userId: '123',
    userName: 'Test',
    contextMessages: [],
    isSessionActive: false,
    isDm: false,
    currentPlaying: null,
    urlContext: null,
    ...over,
  };
}

describe('GeminiAdapter (contracto AiBrain)', () => {
  it('analyzeInteraction devuelve AnalysisResult con shape correcto (Gemma primary, JSON parseado)', async () => {
    // Gemma (primary) no soporta JSON mode → devuelve texto con fences.
    const generateContent = vi.fn().mockResolvedValue({
      text: '```json\n{"is_talking_to_me":true,"intent":"reply","thought_process":"x","response_content":["hola","que"],"reply_to_message_id":null,"ping_users":["9"]}\n```',
      functionCalls: undefined,
    });
    const provider = makeProvider(generateContent);
    const res = await provider.analyzeInteraction(ctx());

    expect(res.intent).toBe('reply');
    expect(res.is_talking_to_me).toBe(true);
    expect(res.response_content).toEqual(['hola', 'que']);
    expect(res.ping_users).toEqual(['9']);
    expect(res.reply_to_message_id).toBeNull();

    // Gemma es primary → primer modelo intentado es uno de los primarios
    // (el shuffle los alterna; el orden exacto es aleatorio).
    const calledModel = generateContent.mock.calls[0][0].model;
    expect(PRIMARY_MODELS).toContain(calledModel);
  });

  it('JSON crudo sin fences: response_content string se normaliza a array de 1', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: '{"is_talking_to_me":false,"intent":"ignore","response_content":"una sola cadena","ping_users":[]}',
      functionCalls: undefined,
    });
    const provider = makeProvider(generateContent);
    const res = await provider.analyzeInteraction(ctx());
    expect(res.intent).toBe('ignore');
    expect(res.response_content).toEqual(['una sola cadena']);
  });

  it('cuota agotada en todos los intentos → client null → intent "ignore" (Python :664)', async () => {
    // 429 → cooldown de todas las keys → initialize() deja client=null →
    // generateWithRetry devuelve null → analyzeInteraction cae al fallback 'ignore'.
    const generateContent = vi.fn().mockRejectedValue(new Error('429 quota exceeded'));
    const provider = makeProvider(generateContent);
    const res = await provider.analyzeInteraction(ctx());
    expect(res.intent).toBe('ignore');
    expect(Array.isArray(res.response_content)).toBe(true);
  });

  it('fallos no-cuota (500/404) agotan modelos → intent "error" (Python :490)', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('500 internal'));
    const provider = makeProvider(generateContent);
    const res = await provider.analyzeInteraction(ctx());
    expect(res.intent).toBe('error');
    expect(Array.isArray(res.response_content)).toBe(true);
    expect((res.response_content[0] as string).toLowerCase()).toContain('error');
  });

  it('generateHolidayGreeting: éxito devuelve texto; fallo devuelve fallback string', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: 'feliz navidad tonto' });
    const p = makeProvider(generateContent);
    await expect(p.generateHolidayGreeting('resumen', 'Navidad')).resolves.toBe('feliz navidad tonto');

    const p2 = makeProvider(vi.fn().mockRejectedValue(new Error('429')));
    await expect(p2.generateHolidayGreeting('resumen', 'Navidad')).resolves.toContain('supongo');
  });

  it('testApiConnection: true cuando hay respuesta real', async () => {
    const p = makeProvider(vi.fn().mockResolvedValue({ text: 'pong' }));
    await expect(p.testApiConnection()).resolves.toBe(true);
  });

  it('testApiConnection: false si no hay keys', async () => {
    const p = makeProvider(vi.fn().mockResolvedValue({ text: 'pong' }));
    (p as any).keys = [];
    await expect(p.testApiConnection()).resolves.toBe(false);
  });

  it('testApiConnection: false si generateWithRetry no devuelve respuesta (regresión del masking bug)', async () => {
    // 500 (no-cuota) agota los modelos → generateWithRetry retorna null (no lanza).
    // Antes testApiConnection devolvía true igual → recoveryProbe creía la API sana.
    const p = makeProvider(vi.fn().mockRejectedValue(new Error('500 internal')));
    await expect(p.testApiConnection()).resolves.toBe(false);
  });
});

describe('parseAnalysisJson (mapper anti-corrupción)', () => {
  it('JSON válido → AnalysisResult tipado con todos los campos', () => {
    const res = parseAnalysisJson(
      '{"intent":"reply","response_content":["hola"],"is_talking_to_me":true,"reply_to_message_id":"55","ping_users":["9"],"thought_process":"t"}',
    );
    expect(res.intent).toBe('reply');
    expect(res.response_content).toEqual(['hola']);
    expect(res.is_talking_to_me).toBe(true);
    expect(res.reply_to_message_id).toBe('55');
    expect(res.ping_users).toEqual(['9']);
    expect(res.thought_process).toBe('t');
  });

  it('response_content string y intent raro → normaliza a string[] e intent "ignore"', () => {
    const res = parseAnalysisJson('{"intent":"hablar","response_content":"una sola","is_talking_to_me":"false"}');
    expect(res.intent).toBe('ignore');
    expect(res.response_content).toEqual(['una sola']);
    expect(res.is_talking_to_me).toBe(false);
  });

  it('garbage sin JSON → errorAnalysisResult canónico', () => {
    const res = parseAnalysisJson('lo siento, no tengo nada que ver con eso');
    expect(res).toEqual(errorAnalysisResult('salida ilegible del modelo'));
    expect(res.intent).toBe('error');
    expect(res.response_content[0]).toContain('Error crítico de IA');
  });

  it('fences con texto alrededor → extrae el objeto balanceado', () => {
    const res = parseAnalysisJson(
      'Claro! ```json\n{"intent":"reply","response_content":["ok"],"is_talking_to_me":true}\n``` espero sirva',
    );
    expect(res.intent).toBe('reply');
    expect(res.response_content).toEqual(['ok']);
  });
});
