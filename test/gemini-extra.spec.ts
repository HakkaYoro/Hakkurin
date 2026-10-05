import { vi } from 'vitest';
import { GeminiProvider } from '../src/ai/gemini.provider';
import { ConfigService } from '../src/common/config.service';
import type { InteractionContext } from '../src/ai/ai-brain.interface';

// Cobertura adicional del provider: prompts de resumen, generateResponse,
// modo fallback persistente, two-pass de web_search y adjuntos de imagen.
// (El contrato base AiBrain está en ai.spec.ts.)

class MockConfig extends ConfigService {
  private store: Record<string, any> = {
    gemini_keys: [],
    system_prompt: 'sys',
    bot_name: 'Hakkurin',
    developer_id: '321799812595056645',
  };
  async load(): Promise<void> {}
  async save(): Promise<void> {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeProvider(generateContent: any) {
  const config = new MockConfig();
  // Fake del puerto ContextBuilder (el provider ya no conoce MemoryService).
  const context = {
    buildInteractionPrompt: async (ctx: any) => ({
      prompt: 'PROMPT',
      imageData: ctx.imageData ?? null,
      imageMime: ctx.imageMimeType ?? null,
    }),
  };
  const provider = new GeminiProvider(config, context);
  (provider as any).keys = ['key-0'];
  (provider as any).createClient = () => ({ models: { generateContent } });
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

describe('GeminiProvider — generateSummary', () => {
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
    const out = await p.generateSummary('viejo', ['nueva interacción'], '777', 'gemma-4-26b-a4b-it');
    expect(out).toBe('perfil nuevo');
    const arg = generateContent.mock.calls[0][0];
    expect(arg.contents).toContain('gestor de memoria a largo plazo');
    expect(arg.contents).toContain('777');
    expect(arg.model).toBe('gemma-4-26b-a4b-it'); // modelo forzado
  });

  it('fallo total → null (el llamador decide qué hacer)', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('500 internal'));
    const p = makeProvider(generateContent);
    await expect(p.generateSummary('', ['x'], '1')).resolves.toBeNull();
  });
});

describe('GeminiProvider — generateResponse', () => {
  it('devuelve texto en éxito y null en fallo total', async () => {
    const ok = vi.fn().mockResolvedValue({ text: 'respuesta corta' });
    const p1 = makeProvider(ok);
    await expect(p1.generateResponse('haz algo')).resolves.toBe('respuesta corta');
    expect(ok.mock.calls[0][0].contents).toContain('haz algo');

    const bad = vi.fn().mockRejectedValue(new Error('500'));
    const p2 = makeProvider(bad);
    await expect(p2.generateResponse('haz algo')).resolves.toBeNull();
  });
});

describe('GeminiProvider — modo fallback persistente', () => {
  it('gemma falla → fallback gemini responde; la SIGUIENTE llamada va directo a fallback', async () => {
    const generateContent = vi.fn()
      // 1ª llamada: gemma 500 → break; 2ª: gemini-2.5-flash ok
      .mockRejectedValueOnce(new Error('500 internal'))
      .mockResolvedValueOnce({ text: 'via fallback' })
      // siguientes llamadas: flash ok directo
      .mockResolvedValue({ text: 'via fallback 2' });
    const p = makeProvider(generateContent);
    await expect(p.generateResponse('x')).resolves.toBe('via fallback');

    const models1 = generateContent.mock.calls.map((c: any[]) => c[0].model);
    expect(models1[0]).toBe('gemma-4-26b-a4b-it');
    expect(models1[1]).toBe('gemini-2.5-flash');

    // fallbackUntil activo → la 2ª petición NO reintenta gemma.
    await expect(p.generateResponse('y')).resolves.toBe('via fallback 2');
    const models2 = generateContent.mock.calls.map((c: any[]) => c[0].model);
    expect(models2.slice(2)).not.toContain('gemma-4-26b-a4b-it'); // tras la 1ª ronda, solo fallback
  });
});

describe('GeminiProvider — web_search two-pass (solo modelos gemini)', () => {
  it('function call web_search → ejecuta búsqueda y re-llama con functionResponse', async () => {
    const generateContent = vi.fn()
      .mockRejectedValueOnce(new Error('500 internal')) // gemma cae
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
    // La 3ª llamada (flash, second pass) incluye el functionResponse con el resultado DDG.
    const third = generateContent.mock.calls[2][0];
    expect(third.model).toBe('gemini-2.5-flash');
    const parts = third.contents[2].parts;
    expect(parts[0].functionResponse.name).toBe('web_search');
    expect(parts[0].functionResponse.response.result).toContain('https://e.com/1');
  });
});

describe('GeminiProvider — analyzeInteraction extras', () => {
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
    expect(arg.model).toBe('gemma-4-26b-a4b-it');
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
