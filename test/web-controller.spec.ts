import { WebController } from '../src/web/web.controller';
import { ConfigService } from '../src/common/config.service';
import { CryptoService } from '../src/memory/crypto.service';
import { MemoryService } from '../src/memory/memory.service';
import { BOT_SELF_ID } from '../src/memory/memory.service';

// Endpoints de la WebUI (server-rendered): config con secretos write-only,
// memories y restart. AuthGuard/ViewService ya tienen su spec en web.spec.ts.

class MockConfig extends ConfigService {
  store: Record<string, any> = { bot_token: 'viejo', gemini_keys: ['k0'] };
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
  const memory = new MemoryService(new CryptoService());
  const discord = { forceShutdownAndSummarize: vi.fn(async () => {}), restart: vi.fn(async () => {}) } as any;
  const brain = { reloadConfig: vi.fn(async () => {}) } as any;
  const view = { render: vi.fn(async () => '<html>ok</html>') } as any;
  const ctl = new WebController(config, memory, discord, brain, view);
  return { ctl, config, memory, discord, brain, view };
}

describe('WebController — root', () => {
  it('renderiza index con flags write-only (sin echo del token/password)', async () => {
    const { ctl, view } = makeController();
    const out = await ctl.root();
    expect(out).toBe('<html>ok</html>');
    const args = view.render.mock.calls[0][1];
    expect(args.has_bot_token).toBe(true);
    expect(args.gemini_keys_count).toBe(1);
    expect(JSON.stringify(args)).not.toContain('viejo'); // el token jamás sale al DOM
    expect(args.navidrome_base_url ?? '').toBe('');
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
