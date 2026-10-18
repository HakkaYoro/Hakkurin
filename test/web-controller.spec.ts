import { UnauthorizedException } from '@nestjs/common';
import { WebController } from '../src/web/infrastructure/web.controller';
import { AuthGuard } from '../src/web/infrastructure/auth.guard';
import { ConfigService } from '../src/common/config.service';
import { CryptoAdapter } from '../src/memory/infrastructure/persistence/crypto.adapter';
import { MemoryRepositoryAdapter } from '../src/memory/infrastructure/persistence/memory-repository.adapter';
import { MemoryQueueAdapter } from '../src/memory/infrastructure/persistence/memory-queue.adapter';
import { MemoryService, BOT_SELF_ID } from '../src/memory/application/memory.service';

// API JSON de la WebUI: config con secretos write-only, stats enriquecido con
// miembros de Discord, memories con nickname y restart. El SPA (React) consume
// estos endpoints; AuthGuard vive aquí abajo.

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
    getMemberInfo: vi.fn(async (id: string) => ({ id, name: `Ana_${id}`, avatarUrl: `http://cdn/${id}.png` })),
  } as any;
  const brain = { reloadConfig: vi.fn(async () => {}) } as any;
  const logTee = { text: vi.fn(() => '2026-10-05T03:54:40Z WARN [SidecarAdapter] falló') } as any;
  const stats = {
    rankings: vi.fn(() => ({
      windowDays: 7,
      totals: { messages: 7, aiCalls: 3, tokensIn: 80, tokensOut: 8, tokensCached: 30, cost: 0.7 },
      prev: { messages: 1, aiCalls: 0, tokensIn: 10, tokensOut: 1, tokensCached: 0, cost: 0 },
      days: [],
      heatmap: [],
      models: [{ model: 'deepseek/v3', calls: 3 }],
      users: [{ id: '100', messages: 5 }],
      commands: [{ command: 'play', count: 2, topUserId: '100', topUserCount: 2 }],
    })),
  } as any;
  const ctl = new WebController(config, memory, discord, brain, logTee, stats);
  return { ctl, config, memory, discord, brain, logTee, stats };
}

describe('AuthGuard', () => {
  const ctx = (headers: Record<string, string> = {}) => {
    const res = { setHeader: () => res };
    return {
      switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => res }),
    } as any;
  };
  const cfg = (token: string | undefined) => ({ get: () => token } as any);
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  it('sin webui_token → permite (localhost es la protección)', () => {
    expect(new AuthGuard(cfg(undefined)).canActivate(ctx())).toBe(true);
  });

  it('con token y sin Authorization → 401 + challenge Basic', () => {
    const g = new AuthGuard(cfg('sekret'));
    expect(() => g.canActivate(ctx())).toThrow(UnauthorizedException);
  });

  it('con token y password incorrecta → 401; correcta (Basic user:token) → permite', () => {
    const g = new AuthGuard(cfg('sekret'));
    expect(() => g.canActivate(ctx({ authorization: `Basic ${b64('user:wrong')}` }))).toThrow(
      UnauthorizedException,
    );
    expect(g.canActivate(ctx({ authorization: `Basic ${b64('user:sekret')}` }))).toBe(true);
  });
});

describe('WebController — api/config', () => {
  it('sólo flags de secretos (jamás sus valores) + campos editables', async () => {
    const { ctl } = makeController();
    const c = await ctl.apiConfig();
    expect(c.has_bot_token).toBe(true);
    expect(c.has_webui_token).toBe(true);
    expect(c.gemini_keys_count).toBe(1);
    expect(c.allowed_channels).toBe('');
    expect(c.ai_provider).toBe('gemini');
    expect(JSON.stringify(c)).not.toContain('viejo'); // bot_token jamás sale
    expect(JSON.stringify(c)).not.toContain('secreto-ui'); // webui_token tampoco
  });
});

describe('WebController — api/status', () => {
  it('sólo flags/contadores, jamás valores de secretos', async () => {
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

describe('WebController — api/stats', () => {
  it('enriquece rankings con nombre + avatar de Discord (con dedupe de resoluciones)', async () => {
    const { ctl, discord } = makeController();
    const r = await ctl.statsData('7');
    expect(discord.getMemberInfo).toHaveBeenCalledTimes(1); // '100' resuelto una sola vez
    expect(r.users[0]).toMatchObject({ id: '100', name: 'Ana_100', avatarUrl: 'http://cdn/100.png', messages: 5 });
    expect(r.commands[0].topUser).toMatchObject({ name: 'Ana_100', count: 2 });
    expect(r.models).toEqual([{ model: 'deepseek/v3', calls: 3 }]);
    expect(r.totals.messages).toBe(7);
  });

  it('miembro irrecuperable (salió del server) → nombre = ID crudo', async () => {
    const { ctl, discord } = makeController();
    discord.getMemberInfo.mockResolvedValue(null);
    const r = await ctl.statsData('30');
    expect(r.users[0].name).toBe('100');
  });

  it('days=30 → rankings de 30 días; otro valor → 7', async () => {
    const { ctl, stats } = makeController();
    await ctl.statsData('30');
    expect(stats.rankings).toHaveBeenCalledWith(30);
    await ctl.statsData('basura');
    expect(stats.rankings).toHaveBeenLastCalledWith(7);
  });
});

describe('WebController — api/update_config', () => {
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

describe('WebController — restart y logs', () => {
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

  it('GET /logs devuelve el contenido del LogTee (descarga plain-text)', () => {
    const { ctl, logTee } = makeController();
    expect(ctl.logs()).toBe(logTee.text());
    expect(ctl.logs()).toContain('[SidecarAdapter]');
  });
});

describe('WebController — api/memories', () => {
  it('lista con nickname y avatar de Discord; memoria interna con etiqueta fija', async () => {
    const { ctl, memory, discord } = makeController();
    await (memory as any).onModuleInit();
    await memory.saveMemory('100', { profile: { name: 'Ana' } });
    await memory.saveMemory(BOT_SELF_ID, {});
    const { memories } = await ctl.memories();
    expect(discord.getMemberInfo).toHaveBeenCalledWith('100');
    const row = memories.find((m: any) => m.user_id === '100');
    expect(row).toMatchObject({ name: 'Ana_100', avatarUrl: 'http://cdn/100.png' });
    expect(memories.find((m: any) => m.user_id === BOT_SELF_ID)).toMatchObject({ name: 'Memoria interna', avatarUrl: null });
  });

  it('miembro irrecuperable → nombre = ID crudo', async () => {
    const { ctl, memory, discord } = makeController();
    discord.getMemberInfo.mockResolvedValue(null);
    await (memory as any).onModuleInit();
    await memory.saveMemory('200', {});
    const { memories } = await ctl.memories();
    expect(memories.find((m: any) => m.user_id === '200').name).toBe('200');
  });

  it('memory_view: usuario normal → summary; BOT_SELF_ID → self memory', async () => {
    const { ctl, memory } = makeController();
    await (memory as any).onModuleInit();
    await memory.updateSummary('300', 'resumen de 300', null);
    const v = await ctl.memoryView('300');
    expect(v.user_id).toBe('300');
    expect(v.content).toContain('resumen de 300');
    const self = await ctl.memoryView(BOT_SELF_ID);
    expect(self.user_id).toBe(BOT_SELF_ID);
    expect(typeof self.content).toBe('string');
  });

  it('delete_all y delete single delegan en MemoryService', async () => {
    const { ctl, memory } = makeController();
    await (memory as any).onModuleInit();
    await memory.saveMemory('400', {});
    await ctl.deleteMemory('400');
    await expect(memory.getMemory('400')).resolves.toMatchObject({ interaction_count: 0 });
    await memory.saveMemory('401', {});
    await ctl.deleteAllMemories();
    expect(await memory.listMemories()).toEqual([]);
  });
});
