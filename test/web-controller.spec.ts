import { WebController } from '../src/web/infrastructure/web.controller';
import { ConfigService } from '../src/common/config.service';
import { CryptoAdapter } from '../src/memory/infrastructure/persistence/crypto.adapter';
import { MemoryRepositoryAdapter } from '../src/memory/infrastructure/persistence/memory-repository.adapter';
import { MemoryQueueAdapter } from '../src/memory/infrastructure/persistence/memory-queue.adapter';
import { MemoryService } from '../src/memory/application/memory.service';
import { BOT_SELF_ID } from '../src/memory/application/memory.service';

// Endpoints de la WebUI (server-rendered): config con secretos write-only,
// memories y restart. AuthGuard/ViewService ya tienen su spec en web.spec.ts.

class MockConfig extends ConfigService {
  store: Record<string, any> = {
    bot_token: 'viejo',
    gemini_keys: ['k0'],
    webui_token: 'secreto-ui',
  };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
  getAll(): any {
    return this.store;
  }
  set(key: string, value: any): Promise<void> {
    this.store[key] = value;
    return Promise.resolve();
  }
}

function makeController() {
  const config = new MockConfig();
  const cryptoSvc = new CryptoAdapter();
  const memory = new MemoryService(cryptoSvc, new MemoryRepositoryAdapter(cryptoSvc), new MemoryQueueAdapter());
  const discord = {
    forceShutdownAndSummarize: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ connected: true, uptimeS: 60, readySince: null, lastDisconnectAt: null })),
  } as any;
  const brain = { reloadConfig: vi.fn(async () => {}) } as any;
  const view = { render: vi.fn(async () => '<html>ok</html>') } as any;
  const logTee = { text: vi.fn(() => '2026-10-05T03:54:40Z WARN [SidecarAdapter] falló') } as any;
  const stats = {
    snapshot: vi.fn(() => [
      { day: '2026-10-16', messages: 3, aiCalls: { analyze: 2 }, tokensIn: 10, tokensOut: 4, tokensCached: 1 },
    ]),
  } as any;
  const ctl = new WebController(config, memory, discord, brain, view, logTee, stats);
  return { ctl, config, memory, discord, brain, view, logTee, stats };
}

describe('WebController — root', () => {
  it('renderiza index con flags write-only (sin echo de ningún secreto)', async () => {
    const { ctl, view } = makeController();
    const out = await ctl.root();
    expect(out).toBe('<html>ok</html>');
    const args = view.render.mock.calls[0][1];
    expect(args.has_bot_token).toBe(true);
    expect(args.has_webui_token).toBe(true);
    expect(args.gemini_keys_count).toBe(1);
    expect(args.allowed_channels).toBe('');
    expect(args.bot.connected).toBe(true);
    expect(args.stats).toHaveLength(1);
    expect(JSON.stringify(args)).not.toContain('viejo'); // el token jamás sale al DOM
    expect(JSON.stringify(args)).not.toContain('secreto-ui'); // webui_token tampoco
    expect(args.navidrome_base_url ?? '').toBe('');
  });
});

describe('WebController — status', () => {
  it('GET /status: sólo flags/contadores, jamás valores de secretos', async () => {
    const { ctl, config } = makeController();
    config.store = {
      bot_token: 'tokensecreto',
      gemini_keys: ['k0', 'k1'],
      webui_token: 'secreto-ui',
      ai_provider: 'openrouter',
      openrouter_api_key: 'sk-secreta',
      openrouter_chat_model: 'anthropic/claude-x',
    };
    const s = ctl.status();
    expect(s.provider).toBe('openrouter');
    expect(s.chatModel).toBe('anthropic/claude-x');
    expect(s.geminiKeysCount).toBe(2);
    expect(s.openrouterConfigured).toBe(true);
    expect(s.bot.connected).toBe(true);
    const json = JSON.stringify(s);
    expect(json).not.toContain('tokensecreto');
    expect(json).not.toContain('sk-secreta');
    expect(json).not.toContain('secreto-ui');
  });

  it('sin chat_model de OpenRouter → openrouterConfigured false', async () => {
    const { ctl } = makeController();
    expect(ctl.status().openrouterConfigured).toBe(false);
  });
});

describe('WebController — update_config', () => {
  it('setea no-secretos y secretos solo si vienen rellenados; parsea keys multilínea', async () => {
    const { ctl, config, brain } = makeController();
    await ctl.updateConfig({
      bot_name: 'Nuevo',
      reply_probability: '0.3',
      developer_id: 'dev',
      navidrome_username: 'pepe',
      bot_token: '', // vacío → NO pisa el token existente
      navidrome_password: 'secreta',
      gemini_keys: ' a \nb\n\n',
    } as any);
    expect(config.store.bot_name).toBe('Nuevo');
    expect(config.store.reply_probability).toBe(0.3);
    expect(config.store.navidrome_username).toBe('pepe');
    expect(config.store.bot_token).toBe('viejo'); // write-only respetado
    expect(config.store.navidrome_password).toBe('secreta');
    expect(config.store.gemini_keys).toEqual(['a', 'b']);
    expect(brain.reloadConfig).toHaveBeenCalledTimes(1); // keys cambiaron → hot reload
  });

  it('sin keys nuevas no recarga el brain; reply_probability basura no se setea', async () => {
    const { ctl, config, brain } = makeController();
    await ctl.updateConfig({ reply_probability: 'no-soy-número', gemini_keys: '   ' } as any);
    expect(brain.reloadConfig).not.toHaveBeenCalled();
    expect(config.store.reply_probability).toBeUndefined();
  });

  it('checkbox deafen: "on" → true; ausente → false', async () => {
    const { ctl, config } = makeController();
    config.store.deafen_move_enabled = true;
    await ctl.updateConfig({ max_history_messages: '30', deafen_move_minutes: '5' } as any);
    expect(config.store.deafen_move_enabled).toBe(false);
    expect(config.store.max_history_messages).toBe(30);
    expect(config.store.deafen_move_minutes).toBe(5);
    await ctl.updateConfig({ deafen_move_enabled: 'on' } as any);
    expect(config.store.deafen_move_enabled).toBe(true);
  });

  it('allowed_channels: textarea multilínea → array limpio', async () => {
    const { ctl, config } = makeController();
    await ctl.updateConfig({ allowed_channels: ' a\nb \n\nc ' } as any);
    expect(config.store.allowed_channels).toEqual(['a', 'b', 'c']);
  });

  it('openrouter_api_key sólo si viene rellena; key/modelo → reload; ai_provider NO', async () => {
    const { ctl, config, brain } = makeController();
    config.store.openrouter_api_key = 'sk-vieja';
    await ctl.updateConfig({ ai_provider: 'openrouter', openrouter_api_key: '   ' } as any);
    expect(config.store.openrouter_api_key).toBe('sk-vieja'); // write-only respetado
    expect(config.store.ai_provider).toBe('openrouter'); // se persiste sin reload
    expect(brain.reloadConfig).not.toHaveBeenCalled(); // cambiar ai_provider no recarga
    await ctl.updateConfig({ openrouter_chat_model: 'x' } as any);
    expect(brain.reloadConfig).toHaveBeenCalledTimes(1);
    await ctl.updateConfig({ openrouter_api_key: 'sk-nueva', openrouter_memory_model: 'y' } as any);
    expect(config.store.openrouter_api_key).toBe('sk-nueva');
    expect(brain.reloadConfig).toHaveBeenCalledTimes(2);
  });

  it('ai_provider: valor inválido se ignora; ausente no toca el actual', async () => {
    const { ctl, config } = makeController();
    config.store.ai_provider = 'gemini';
    await ctl.updateConfig({ ai_provider: 'malware' } as any);
    expect(config.store.ai_provider).toBe('gemini');
    await ctl.updateConfig({ bot_name: 'n' } as any);
    expect(config.store.ai_provider).toBe('gemini');
    await ctl.updateConfig({ ai_provider: 'gemini' } as any);
    expect(config.store.ai_provider).toBe('gemini');
  });
});

describe('WebController — restart', () => {
  it('dispara shutdown+resumen y luego restart en background', async () => {
    const { ctl, discord } = makeController();
    ctl.restart();
    await vi.waitFor(() => expect(discord.restart).toHaveBeenCalled());
    expect(discord.forceShutdownAndSummarize).toHaveBeenCalledTimes(1);
  });

  it('si el shutdown falla, NO se reinicia el cliente (catch evita unhandledRejection)', async () => {
    const { ctl, discord } = makeController();
    discord.forceShutdownAndSummarize.mockRejectedValue(new Error('fs roto'));
    ctl.restart();
    await new Promise((r) => setTimeout(r, 10));
    expect(discord.restart).not.toHaveBeenCalled();
  });
});

describe('WebController — logs', () => {
  it('GET /logs devuelve el contenido del LogTee (descarga plain-text)', () => {
    const { ctl, logTee } = makeController();
    expect(ctl.logs()).toBe(logTee.text());
    expect(ctl.logs()).toContain('[SidecarAdapter]');
  });
});

describe('WebController — memories', () => {
  it('memories: lista renderizada con lo que devuelve MemoryService', async () => {
    const { ctl, memory, view } = makeController();
    await (memory as any).onModuleInit();
    await memory.saveMemory('100', { profile: { name: 'Ana' } });
    await ctl.memories();
    const args = view.render.mock.calls[0][1];
    expect(args.memories.some((m: any) => m.user_id === '100')).toBe(true);
  });

  it('memory_view: usuario normal → summary; BOT_SELF_ID → self memory', async () => {
    const { ctl, memory, view } = makeController();
    await (memory as any).onModuleInit();
    await memory.updateSummary('200', 'resumen de 200', null);
    await ctl.memoryView('200');
    expect(view.render.mock.calls[0][0]).toBe('memory_view.html');
    expect(view.render.mock.calls[0][1].content).toContain('resumen de 200');

    await ctl.memoryView(BOT_SELF_ID);
    const selfArgs = view.render.mock.calls[1][1];
    expect(selfArgs.user_id).toBe(BOT_SELF_ID);
    expect(typeof selfArgs.content).toBe('string');
  });

  it('delete_all y delete single delegan en MemoryService', async () => {
    const { ctl, memory } = makeController();
    await (memory as any).onModuleInit();
    await memory.saveMemory('300', {});
    await ctl.deleteMemory('300');
    await expect(memory.getMemory('300')).resolves.toMatchObject({ interaction_count: 0 });
    await memory.saveMemory('301', {});
    await ctl.deleteAllMemories();
    expect(await memory.listMemories()).toEqual([]);
  });
});
