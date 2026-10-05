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

describe('GeminiAdapter — generateSummary', () => {
  it('self-memory: prompt de conciencia interna y devuelve el texto', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: '### ESTADO\nenergía alta' });
    const p = makeProvider(generateContent);
    const out = await p.generateSummary('memoria previa', ['[YO DIJE/HICE]: x'], 'hakkurin_internal_self');
    expect(out).toBe('### ESTADO\nenergía alta');
    const arg = generateContent.mock.calls[0][0];
    expect(arg.contents).toContain('SISTEMA DE CONCIENCIA Y MEMORIA');
    expect(arg.contents).toContain('memoria previa');
    expect(arg.contents).toContain('[YO DIJE/HICE]: x');
  });

  it('perfil de usuario: prompt de gestor de memoria con el ID del usuario', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: 'perfil nuevo' });
    const p = makeProvider(generateContent);
    const out = await p.generateSummary('viejo', ['nueva interacción'], '777', PRIMARY_MODELS[0]);
    expect(out).toBe('perfil nuevo');
    const arg = generateContent.mock.calls[0][0];
    expect(arg.contents).toContain('gestor de memoria a largo plazo');
    expect(arg.contents).toContain('777');
    expect(arg.model).toBe(PRIMARY_MODELS[0]); // modelo forzado
  });

  it('fallo total → null (el llamador decide qué hacer)', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('500 internal'));
    const p = makeProvider(generateContent);
    await expect(p.generateSummary('', ['x'], '1')).resolves.toBeNull();
  });
});

describe('GeminiAdapter — generateResponse', () => {
  it('devuelve texto en éxito y null en fallo total', async () => {
    const ok = vi.fn().mockResolvedValue({ text: 'respuesta corta' });
    const p1 = makeProvider(ok);
    await expect(p1.generateResponse('haz algo')).resolves.toBe('respuesta corta');
    expect(ok.mock.calls[0][0].contents).toContain('haz algo');

    const bad = vi.fn().mockRejectedValue(new Error('500'));
    const p2 = makeProvider(bad);
    await expect(p2.generateResponse('haz algo')).resolves.toBeNull();
  });

  it('respuesta vacía del primario → 2º intento del mismo modelo y luego el siguiente del ladder', async () => {
    // Gemma 31b-it devolvía '' en el resumen horario y se aceptaba en silencio.
    const generateContent = vi.fn()
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValueOnce({ text: '' }) // mismo modelo, reintento
      .mockResolvedValue({ text: 'respuesta buena' });
    const p = makeProvider(generateContent);
    await expect(p.generateResponse('x')).resolves.toBe('respuesta buena');
    const models = generateContent.mock.calls.map((c: any[]) => c[0].model);
    expect(generateContent.mock.calls).toHaveLength(3);
    expect(models[0]).toBe(models[1]); // 2 intentos del mismo primario
    expect(models[2]).not.toBe(models[0]); // el ladder siguió con otro modelo
  });
});

describe('GeminiAdapter — modo fallback persistente', () => {
  it('gemmas fallan → fallback gemini responde; la SIGUIENTE llamada va directo a fallback', async () => {
    const generateContent = vi.fn()
      // 1ª y 2ª: los dos primarios gemma 500 → break; 3ª: gemini-2.5-flash ok
      .mockRejectedValueOnce(new Error('500 internal'))
      .mockRejectedValueOnce(new Error('500 internal'))
      .mockResolvedValueOnce({ text: 'via fallback' })
      // siguientes llamadas: flash ok directo
      .mockResolvedValue({ text: 'via fallback 2' });
    const p = makeProvider(generateContent);
    await expect(p.generateResponse('x')).resolves.toBe('via fallback');

    const models1 = generateContent.mock.calls.map((c: any[]) => c[0].model);
    // shuffle: los dos primeros intentos son los primarios en orden aleatorio
    expect(PRIMARY_MODELS).toContain(models1[0]);
    expect(PRIMARY_MODELS).toContain(models1[1]);
    expect(models1[2]).toBe('gemini-2.5-flash');

    // fallbackUntil activo → la 2ª petición NO reintenta gemma.
    await expect(p.generateResponse('y')).resolves.toBe('via fallback 2');
    const models2 = generateContent.mock.calls.map((c: any[]) => c[0].model);
    expect(models2.slice(3).some((m) => m.includes('gemma'))).toBe(false); // tras la 1ª ronda, solo fallback
  });
});

describe('GeminiAdapter — web_search two-pass (solo modelos gemini)', () => {
  it('function call web_search → ejecuta búsqueda y re-llama con functionResponse', async () => {
    const generateContent = vi.fn()
      .mockRejectedValueOnce(new Error('500 internal')) // gemma 31b cae
      .mockRejectedValueOnce(new Error('500 internal')) // gemma 26b cae
      // 1ª a flash: pide web_search
      .mockResolvedValueOnce({
        text: '',
        functionCalls: [{ name: 'web_search', args: { query: 'clima hoy' } }],
        candidates: [{ content: { parts: [{ text: 'buscando...' }] } }],
      })
      // 2ª a flash (con la respuesta de la tool): JSON final
      .mockResolvedValueOnce({
        text: '{"intent":"reply","response_content":["hace sol"],"is_talking_to_me":true}',
      });
    const p = makeProvider(generateContent);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => '<a class="result-link" href="https://e.com/1" >R</a><a class="result-snippet" >s</a>',
    })));
    const out = await p.analyzeInteraction(ctx({ userText: 'qué tiempo hace' }));
    vi.unstubAllGlobals();

    expect(out.intent).toBe('reply');
    expect(out.response_content).toEqual(['hace sol']);
    // La 2ª pasada de flash (tras los 2 gemmas + 1ª flash) incluye el
    // functionResponse con el resultado DDG.
    const third = generateContent.mock.calls[3][0];
    expect(third.model).toBe('gemini-2.5-flash');
    const parts = third.contents[2].parts;
    expect(parts[0].functionResponse.name).toBe('web_search');
    expect(parts[0].functionResponse.response.result).toContain('https://e.com/1');
  });
});

describe('GeminiAdapter — analyzeInteraction extras', () => {
  it('adjunta la imagen como parte base64 y registra la petición en la key activa', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: '```json\n{"intent":"reply","response_content":["hola"],"is_talking_to_me":true}\n```',
    });
    const p = makeProvider(generateContent);
    const image = Buffer.from('fake-png');
    await p.analyzeInteraction(ctx({ imageData: image, imageMimeType: 'image/png' }));

    const arg = generateContent.mock.calls[0][0];
    expect(arg.contents).toHaveLength(2);
    expect(arg.contents[1].inlineData.mimeType).toBe('image/png');
    const usage = (p as any).keyUsage.get((p as any).currentKeyIndex);
    expect(usage.requestsToday).toBe(1);
  });

  it('Gemma sin JSON mode: responseMimeType se elimina en el config de la llamada', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: '{"intent":"ignore","response_content":[],"is_talking_to_me":false}',
    });
    const p = makeProvider(generateContent);
    await p.analyzeInteraction(ctx());
    const arg = generateContent.mock.calls[0][0];
    expect(PRIMARY_MODELS).toContain(arg.model); // el shuffle elige el primario
    expect(arg.config.responseMimeType).toBeUndefined();
  });

  it('reloadConfig repuebla keys y reconstruye el cliente con la key activa', async () => {
    const p = makeProvider(vi.fn());
    const created: string[] = [];
    (p as any).createClient = (apiKey: string) => {
      created.push(apiKey);
      return { models: { generateContent: vi.fn().mockResolvedValue({ text: 'pong' }) } };
    };
    (p as any).config.get = (key: string, d?: any) => (key === 'gemini_keys' ? ['nueva-key'] : (d as any));
    await p.reloadConfig();
    expect(created).toEqual(['nueva-key']);
    expect((p as any).client).not.toBeNull();
  });

  it('sin keys: initialize deja client null (no peta)', async () => {
    const p = makeProvider(vi.fn());
    await expect(p.reloadConfig()).resolves.toBeUndefined();
    expect((p as any).client).toBeNull();
  });
});
