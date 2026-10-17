import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter } from '../src/discord/infrastructure/discord.adapter';
import { ConfigService } from '../src/common/config.service';

class MockConfig extends ConfigService {
  store: Record<string, any> = {
    deafen_move_enabled: true,
    deafen_move_channel_id: 'target',
    deafen_move_minutes: 3,
  };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

// Adapter con las dependencias mínimas para el ciclo de conexión y voice states:
// el resto de colaboradores no se toca en estos caminos.
function makeAdapter(store: Record<string, any> = {}) {
  const config = new MockConfig();
  Object.assign(config.store, store);
  const svc = new DiscordAdapter(
    config, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any,
  );
  const start = vi.fn(async () => {});
  (svc as any).start = start;
  return { svc, config, start };
}

describe('DiscordAdapter — getStatus (BotLifecycle)', () => {
  it('cliente ready → connected con readySince ISO', () => {
    const { svc } = makeAdapter();
    (svc as any).client = { isReady: () => true, readyTimestamp: 1_700_000_000_000 };
    const status = svc.getStatus();
    expect(status.connected).toBe(true);
    expect(status.readySince).toBe(new Date(1_700_000_000_000).toISOString());
    expect(status.uptimeS).toBeTypeOf('number');
  });

  it('sin cliente → connected false, sin fechas', () => {
    const { svc } = makeAdapter();
    expect(svc.getStatus()).toEqual({
      connected: false,
      uptimeS: expect.any(Number),
      readySince: null,
      lastDisconnectAt: null,
    });
  });
});

describe('DiscordAdapter — watchdog de conexión', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('cliente ready → no hace nada y resetea el contador', async () => {
    const { svc, start } = makeAdapter();
    (svc as any).client = { isReady: () => true, destroy: vi.fn(async () => {}) };
    await svc.connectionWatchdog();
    await svc.connectionWatchdog();
    expect(start).not.toHaveBeenCalled();
    expect((svc as any).notReadyChecks).toBe(0);
  });

  it('2 checks sin ready toleran; el 3º destruye y recrea', async () => {
    const { svc, start } = makeAdapter();
    const destroy = vi.fn(async () => {});
    (svc as any).client = { isReady: () => false, destroy };
    (svc as any).pending.set('c1:u1', new AbortController());

    await svc.connectionWatchdog();
    await svc.connectionWatchdog();
    expect(start).not.toHaveBeenCalled();

    await svc.connectionWatchdog();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect((svc as any).client).toBeNull(); // recreado por start()
    expect((svc as any).pending.size).toBe(0);
  });

  it('ready intercalado reinicia la cuenta (outage intermitente no recrea)', async () => {
    const { svc, start } = makeAdapter();
    let ready = false;
    (svc as any).client = { isReady: () => ready, destroy: vi.fn(async () => {}) };
    await svc.connectionWatchdog();
    await svc.connectionWatchdog();
    ready = true;
    await svc.connectionWatchdog();
    ready = false;
    await svc.connectionWatchdog();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('DiscordAdapter — mover ensordecidos', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function voiceFixture(setChannel: any) {
    const member: any = {
      user: { bot: false, displayName: 'Alice' },
      voice: { channelId: 'vc1', selfDeaf: true, setChannel },
    };
    const guild: any = {
      id: 'g1',
      members: { cache: new Map([['u1', member]]), fetch: vi.fn() },
    };
    const cur: any = { id: 'u1', member, guild, channelId: 'vc1', selfDeaf: true };
    return { member, guild, cur };
  }

  it('3 min autoensordecido fuera del destino → setChannel al destino', async () => {
    vi.useFakeTimers();
    const setChannel = vi.fn(async () => {});
    const { svc } = makeAdapter();
    const { cur } = voiceFixture(setChannel);
    (svc as any).client = {
      isReady: () => true,
      guilds: { cache: new Map([['g1', cur.guild]]) },
    };

    (svc as any).onVoiceStateUpdate(cur, cur);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(setChannel).toHaveBeenCalledWith('target');
  });

  it('destensordearse antes del timeout cancela el movimiento', async () => {
    vi.useFakeTimers();
    const setChannel = vi.fn(async () => {});
    const { svc } = makeAdapter();
    const { member, cur } = voiceFixture(setChannel);
    (svc as any).client = {
      isReady: () => true,
      guilds: { cache: new Map([['g1', cur.guild]]) },
    };

    (svc as any).onVoiceStateUpdate(cur, cur);
    member.voice.selfDeaf = false;
    (svc as any).onVoiceStateUpdate(cur, cur);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(setChannel).not.toHaveBeenCalled();
  });

  it('cambiar de canal ensordecido NO reinicia el timer; llegar al destino lo cancela', async () => {
    vi.useFakeTimers();
    const setChannel = vi.fn(async () => {});
    const { svc } = makeAdapter();
    const { member, cur } = voiceFixture(setChannel);
    (svc as any).client = {
      isReady: () => true,
      guilds: { cache: new Map([['g1', cur.guild]]) },
    };

    (svc as any).onVoiceStateUpdate(cur, cur);
    const moved: any = { ...cur, channelId: 'vc2' };
    member.voice.channelId = 'vc2';
    (svc as any).onVoiceStateUpdate(cur, moved);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    member.voice.channelId = 'target';
    const atTarget: any = { ...cur, channelId: 'target' };
    (svc as any).onVoiceStateUpdate(cur, atTarget);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setChannel).not.toHaveBeenCalled();
  });

  it('bots y feature desactivada no generan timer', async () => {
    vi.useFakeTimers();
    const setChannel = vi.fn(async () => {});
    const { svc, config } = makeAdapter();
    config.store.deafen_move_enabled = false;
    const { member, cur } = voiceFixture(setChannel);
    (svc as any).client = {
      isReady: () => true,
      guilds: { cache: new Map([['g1', cur.guild]]) },
    };

    (svc as any).onVoiceStateUpdate(cur, cur);
    member.user.bot = true;
    config.store.deafen_move_enabled = true;
    (svc as any).onVoiceStateUpdate(cur, cur);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(setChannel).not.toHaveBeenCalled();
    expect((svc as any).deafTimers.size).toBe(0);
  });
});
