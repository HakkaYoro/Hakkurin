import { vi } from 'vitest';
import { OpenRouterAdapter } from '../src/ai/infrastructure/adapters/openrouter.adapter';
import { RoutingBrain } from '../src/ai/application/routing-brain.service';
import { errorAnalysisResult } from '../src/ai/infrastructure/mappers/gemini.mapper';
import { ConfigService } from '../src/common/config.service';
import type { InteractionContext } from '../src/ai/domain/ports/ai-brain.port';

// Contrato AiBrain del OpenRouterAdapter con chat.send mockeado. No toca la red.

class MockConfig extends ConfigService {
  store: Record<string, any>;
  constructor(store: Record<string, any> = {}) {
    super();
    this.store = {
      openrouter_api_key: 'test-key',
      openrouter_chat_model: 'deepseek/deepseek-v3.1',
      ...store,
    };
  }
  async load(): Promise<void> {}
  async save(): Promise<void> {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

class FakeStats {
  tokens = { in: 0, out: 0, cached: 0 };
  cost = 0;
  calls: string[] = [];
  addTokens(i: number, o: number, c = 0, cost = 0): void {
    this.tokens.in += i;
    this.tokens.out += o;
    this.tokens.cached += c;
    this.cost += cost;
  }
  bumpAiCall(kind: string): void {
    this.calls.push(kind);
  }
}

function completion(content: any, usage?: any) {
  return { choices: [{ message: { content } }], usage };
}

function makeAdapter(chatSend: any, store: Record<string, any> = {}) {
  const config = new MockConfig(store);
  const context = {
    buildInteractionPrompt: async (ctx: any) => ({
      prompt: 'PROMPT',
      imageData: ctx.imageData ?? null,
      imageMime: ctx.imageMimeType ?? null,
    }),
  };
  const stats = new FakeStats();
  const adapter = new OpenRouterAdapter(config, context as any, stats as any);
  // stubs del cargador de SDK y del factory de cliente: nunca se carga el SDK real.
  (adapter as any).loadSdk = async () => ({ OpenRouter: class {} });
  (adapter as any).createClient = () => ({ chat: { send: chatSend } });
  return { adapter, chatSend, stats, config };
}

function ctx(over: Partial<InteractionContext> = {}): InteractionContext {
  return {
    userText: 'hola',
    userId: '123',
    userName: 'Test',
    contextMessages: [],
    isDm: false,
    currentPlaying: null,
    urlContext: null,
    ...over,
  };
}

describe('OpenRouterAdapter (contrato AiBrain)', () => {
  it('analyzeInteraction: modelo de chat, JSON con fences parseado vía parseAnalysisJson', async () => {
    const chatSend = vi.fn().mockResolvedValue(
      completion('```json\n{"intent":"reply","response_content":["hola","que"],"is_talking_to_me":true,"ping_users":["9"]}\n```'),
    );
    const { adapter, chatSend: send } = makeAdapter(chatSend);
    const res = await adapter.analyzeInteraction(ctx());

    expect(res.intent).toBe('reply');
    expect(res.is_talking_to_me).toBe(true);
    expect(res.response_content).toEqual(['hola', 'que']);
    expect(res.ping_users).toEqual(['9']);

    const req = send.mock.calls[0][0].chatRequest;
    expect(req.model).toBe('deepseek/deepseek-v3.1');
    expect(req.maxTokens).toBe(800);
    expect(req.cacheControl).toBeUndefined(); // no es anthropic/ → caching automático
  });

  it('session_id sticky: hakkurin-chat para la familia chat y hakkurin-mem para memoria', async () => {
    const chatSend = vi.fn().mockResolvedValue(completion('ok'));
    const { adapter } = makeAdapter(chatSend, { openrouter_memory_model: 'anthropic/claude-haiku' });

    await adapter.generateResponse('x');
    expect(chatSend.mock.calls[0][0].chatRequest.sessionId).toBe('hakkurin-chat');

    await adapter.generateSummary('viejo', ['nueva'], '777');
    expect(chatSend.mock.calls[1][0].chatRequest.sessionId).toBe('hakkurin-mem');
    expect(chatSend.mock.calls[1][0].chatRequest.model).toBe('anthropic/claude-haiku');
  });

  it('modelo de memoria no configurado → usa el de chat (misma sesión mem)', async () => {
    const chatSend = vi.fn().mockResolvedValue(completion('perfil'));
    const { adapter } = makeAdapter(chatSend); // sin openrouter_memory_model
    const out = await adapter.generateSummary('viejo', ['nueva'], '777');
    expect(out).toBe('perfil');
    const req = chatSend.mock.calls[0][0].chatRequest;
    expect(req.model).toBe('deepseek/deepseek-v3.1');
    expect(req.sessionId).toBe('hakkurin-mem');
  });

  it('cacheControl ephemeral solo para modelos anthropic/', async () => {
    const chatSend = vi.fn().mockResolvedValue(completion('ok'));
    const { adapter } = makeAdapter(chatSend, { openrouter_memory_model: 'anthropic/claude-haiku' });

    await adapter.generateSummary('viejo', ['nueva'], '777');
    expect(chatSend.mock.calls[0][0].chatRequest.cacheControl).toEqual({ type: 'ephemeral' });

    await adapter.generateResponse('x');
    expect(chatSend.mock.calls[1][0].chatRequest.cacheControl).toBeUndefined();
  });

  it('qwen: cache_control por bloque (content string → parts con cacheControl)', async () => {
    const chatSend = vi.fn().mockResolvedValue(completion('ok'));
    const { adapter } = makeAdapter(chatSend, { openrouter_chat_model: 'qwen/qwen4-72b' });

    await adapter.generateResponse('hola');
    const req = chatSend.mock.calls[0][0].chatRequest;
    expect(req.cacheControl).toBeUndefined();
    expect(req.messages[0].content).toEqual([
      { type: 'text', text: expect.stringContaining('hola'), cacheControl: { type: 'ephemeral' } },
    ]);
  });

  it('reasoning effort: low → chatRequest.reasoning={effort}; none → none; default/ausente → sin campo', async () => {
    const low = makeAdapter(vi.fn().mockResolvedValue(completion('ok')), { openrouter_reasoning_effort: 'low' });
    await low.adapter.generateResponse('x');
    expect(low.chatSend.mock.calls[0][0].chatRequest.reasoning).toEqual({ effort: 'low' });

    const off = makeAdapter(vi.fn().mockResolvedValue(completion('ok')), { openrouter_reasoning_effort: 'none' });
    await off.adapter.generateResponse('x');
    expect(off.chatSend.mock.calls[0][0].chatRequest.reasoning).toEqual({ effort: 'none' });

    const def = makeAdapter(vi.fn().mockResolvedValue(completion('ok')), { openrouter_reasoning_effort: 'default' });
    await def.adapter.generateResponse('x');
    expect(def.chatSend.mock.calls[0][0].chatRequest.reasoning).toBeUndefined();

    const absent = makeAdapter(vi.fn().mockResolvedValue(completion('ok')));
    await absent.adapter.generateResponse('x');
    expect(absent.chatSend.mock.calls[0][0].chatRequest.reasoning).toBeUndefined();
  });

  it('qwen: content ya en parts → cacheControl sobre el primer bloque texto', async () => {
    const chatSend = vi.fn().mockResolvedValue(completion('{"intent":"ignore","response_content":[],"is_talking_to_me":false,"ping_users":[]}'));
    const { adapter, chatSend: send } = makeAdapter(chatSend, { openrouter_chat_model: 'qwen/qwen4-72b' });

    await adapter.analyzeInteraction(ctx());
    const parts = send.mock.calls[0][0].chatRequest.messages[0].content;
    expect(parts[0].cacheControl).toEqual({ type: 'ephemeral' });
    expect(parts[0].text).toBe('PROMPT');
  });

  it('cost de usage se registra en stats junto a los tokens', async () => {
    const chatSend = vi.fn().mockResolvedValue(
      completion('ok', { promptTokens: 10, completionTokens: 5, promptTokensDetails: { cachedTokens: 3 }, cost: 0.0021 }),
    );
    const { adapter, stats } = makeAdapter(chatSend);

    await adapter.generateResponse('x');
    expect(stats.tokens).toEqual({ in: 10, out: 5, cached: 3 });
    expect(stats.cost).toBeCloseTo(0.0021);
  });

  it('fallo en todos los intentos → errorAnalysisResult, nunca lanza (2 intentos)', async () => {
    const chatSend = vi.fn().mockRejectedValue(new Error('503 upstream'));
    const { adapter, chatSend: send } = makeAdapter(chatSend);
    const res = await adapter.analyzeInteraction(ctx());

    expect(res.intent).toBe('error');
    expect(res.response_content[0]).toContain('Error crítico de IA');
    expect(res.response_content[0]).toContain('503');
    expect(send.mock.calls).toHaveLength(2);
  });

  it('analyzeInteraction sin key → errorAnalysisResult("sin API key de OpenRouter")', async () => {
    // Sin key el adapter nunca construye cliente: no hace falta stub de red.
    const config = new MockConfig({ openrouter_api_key: '' });
    const context = { buildInteractionPrompt: async () => ({ prompt: 'P', imageData: null, imageMime: null }) };
    const adapter = new OpenRouterAdapter(config, context as any, new FakeStats() as any);
    const res = await adapter.analyzeInteraction(ctx());

    expect(res).toEqual(errorAnalysisResult('sin API key de OpenRouter'));
    await expect(adapter.testApiConnection()).resolves.toBe(false);
    await expect(adapter.generateResponse('x')).resolves.toBeNull();
  });

  it('sin modelo de chat configurado → degradado como no configurado, sin llamar a la API', async () => {
    const chatSend = vi.fn();
    const { adapter, stats } = makeAdapter(chatSend, { openrouter_chat_model: '' });
    const res = await adapter.analyzeInteraction(ctx());

    expect(res.intent).toBe('error');
    expect(chatSend).not.toHaveBeenCalled();
    await expect(adapter.generateSummary('', ['x'], '1')).resolves.toBeNull();
    await expect(adapter.generateHolidayGreeting('r', 'Navidad')).resolves.toContain('supongo');
    await expect(adapter.testApiConnection()).resolves.toBe(false);
    expect(stats.calls).toEqual([]); // el contador vive en RoutingBrain, no acá
  });

  it('generateSummary: fallo total → null', async () => {
    const chatSend = vi.fn().mockRejectedValue(new Error('500'));
    const { adapter } = makeAdapter(chatSend);
    await expect(adapter.generateSummary('', ['x'], '1')).resolves.toBeNull();
  });

  it('tokens registrados en StatsService (cached incluido) y vacío → retry', async () => {
    const chatSend = vi
      .fn()
      .mockResolvedValueOnce(completion('', { promptTokens: 10, completionTokens: 2 }))
      .mockResolvedValue(
        completion('respuesta', { promptTokens: 10, completionTokens: 5, promptTokensDetails: { cachedTokens: 3 } }),
      );
    const { adapter, stats } = makeAdapter(chatSend);
    const out = await adapter.generateResponse('x');

    expect(out).toBe('respuesta');
    // 1ª llamada vacía también consumió tokens; 2ª exitosa suma encima.
    expect(stats.tokens).toEqual({ in: 20, out: 7, cached: 3 });
  });

  it('respuesta con content en partes (array) se concatena', async () => {
    const chatSend = vi.fn().mockResolvedValue(
      completion([{ type: 'text', text: 'par' }, { type: 'text', text: 'te' }]),
    );
    const { adapter } = makeAdapter(chatSend);
    await expect(adapter.generateResponse('x')).resolves.toBe('parte');
  });

  it('testApiConnection: true solo con texto real; respuesta vacía → false', async () => {
    const ok = makeAdapter(vi.fn().mockResolvedValue(completion('pong')));
    await expect(ok.adapter.testApiConnection()).resolves.toBe(true);
    expect(ok.chatSend.mock.calls[0][0].chatRequest.maxTokens).toBe(5);

    const empty = makeAdapter(vi.fn().mockResolvedValue(completion('')));
    await expect(empty.adapter.testApiConnection()).resolves.toBe(false);
  });

  it('loadSdk resuelve el SDK ESM real (import dinámico bajo módulo CJS)', async () => {
    const context = { buildInteractionPrompt: async () => ({ prompt: 'P', imageData: null, imageMime: null }) };
    const adapter = new OpenRouterAdapter(new MockConfig(), context as any, new FakeStats() as any);
    (adapter as any).createClient = () => ({ ok: true });
    await adapter.reloadConfig();
    expect((adapter as any).client).toBeTruthy();
  });

  it('imagen adjunta viaja como image_url data-URL base64', async () => {
    const chatSend = vi.fn().mockResolvedValue(
      completion('```json\n{"intent":"reply","response_content":["veo"],"is_talking_to_me":true}\n```'),
    );
    const { adapter } = makeAdapter(chatSend);
    await adapter.analyzeInteraction(ctx({ imageData: Buffer.from('png'), imageMimeType: 'image/png' }));

    const messages = chatSend.mock.calls[0][0].chatRequest.messages;
    expect(messages[0].role).toBe('user');
    expect(messages[0].content[0].type).toBe('text');
    expect(messages[0].content[1]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${Buffer.from('png').toString('base64')}` },
    });
  });
});

describe('RoutingBrain (hot-swap + conteo)', () => {
  function fakeBrain() {
    return {
      analyzeInteraction: vi.fn().mockResolvedValue({ intent: 'ignore', response_content: [], is_talking_to_me: false, ping_users: [] }),
      generateResponse: vi.fn().mockResolvedValue('r'),
      generateSummary: vi.fn().mockResolvedValue('s'),
      generateHolidayGreeting: vi.fn().mockResolvedValue('h'),
      testApiConnection: vi.fn().mockResolvedValue(true),
      reloadConfig: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('delega al proveedor leído EN CALIENTE y cuenta llamadas', async () => {
    const gemini = fakeBrain();
    const openrouter = fakeBrain();
    const config = new MockConfig({ ai_provider: 'openrouter' });
    const stats = new FakeStats();
    const brain = new RoutingBrain(gemini as any, openrouter as any, config, stats as any);

    await brain.analyzeInteraction(ctx());
    await brain.generateSummary('', ['x'], '1');
    await brain.testApiConnection(); // no cuenta
    expect(openrouter.analyzeInteraction).toHaveBeenCalled();
    expect(stats.calls).toEqual(['analyze', 'summary']);

    // hot-swap sin reiniciar: la siguiente llamada va a gemini
    config.store.ai_provider = 'gemini';
    await brain.generateResponse('x');
    expect(gemini.generateResponse).toHaveBeenCalled();
    expect(stats.calls).toEqual(['analyze', 'summary', 'response']);
  });

  it('reloadConfig delega a ambos adapters', async () => {
    const gemini = fakeBrain();
    const openrouter = fakeBrain();
    const brain = new RoutingBrain(gemini as any, openrouter as any, new MockConfig(), new FakeStats() as any);
    await brain.reloadConfig();
    expect(gemini.reloadConfig).toHaveBeenCalled();
    expect(openrouter.reloadConfig).toHaveBeenCalled();
  });
});
