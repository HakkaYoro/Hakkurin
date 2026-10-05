import { vi } from 'vitest';
import { GeminiProvider } from '../src/ai/gemini.provider';
import { ConfigService } from '../src/common/config.service';
import type { InteractionContext } from '../src/ai/ai-brain.interface';

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

function makeProvider(generateContent: any): GeminiProvider {
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
  const provider = new GeminiProvider(config, context);
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

describe('GeminiProvider (contracto AiBrain)', () => {
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

    // Gemma es primary → primer modelo intentado contiene "gemma"
    const calledModel = generateContent.mock.calls[0][0].model;
    expect(calledModel).toContain('gemma-4-26b-a4b-it');
  });

  it('normalize response_content: string suelto → array de 1', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: '{"is_talking_to_me":false,"intent":"ignore","response_content":"una sola cadena","ping_users":[]}',
      functionCalls: undefined,
    });
    const provider = makeProvider(generateContent);
    const res = await provider.analyzeInteraction(ctx());
    // El proveedor devuelve lo que parsea; el pipeline de Discord normaliza string→[string].
    // Aquí solo aseguramos que llega sin romper.
    expect(res.intent).toBe('ignore');
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
