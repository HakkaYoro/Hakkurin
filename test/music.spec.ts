import { vi } from 'vitest';

// Fakes de comportamiento de la capa de voz (@discordjs/voice): player y conexión
// falsos que graban llamadas. El resto del módulo se usa real. ffmpeg se spawnea
// de verdad con URLs que rechazan al instante (127.0.0.1:9) — no hay audio real.
const h = vi.hoisted(() => {
  const conns = new Map<string, any>();
  let lastPlayer: any = null;
  function makeFakePlayer() {
    const listeners = new Map<string, any[]>();
    const player: any = {
      state: { status: 'idle' },
      play: vi.fn(),
      stop: vi.fn(),
      on: (ev: string, fn: any) => {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev)!.push(fn);
      },
      _emit: (ev: string) => (listeners.get(ev) ?? []).forEach((f) => f()),
    };
    lastPlayer = player;
    return player;
  }
  function makeFakeConnection(guildId: string) {
    return {
      guildId,
      joinConfig: { channelId: 'vc1' },
      state: { status: 'ready' },
      subscribe: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };
  }
  return {
    conns,
    lastPlayer: () => lastPlayer,
    makeFakePlayer,
    makeFakeConnection,
    getVoiceConnection: (gid: string) => conns.get(gid) ?? null,
    joinVoiceChannel: (opts: any) => {
      const c = makeFakeConnection(opts.guildId);
      conns.set(opts.guildId, c);
      return c;
    },
    entersState: async (conn: any) => conn,
  };
});

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getVoiceConnection: h.getVoiceConnection,
    joinVoiceChannel: h.joinVoiceChannel,
    entersState: h.entersState,
    createAudioPlayer: () => h.makeFakePlayer(),
    createAudioResource: () => ({ metadata: null }),
  };
});

import { ChannelType } from 'discord.js';
import { MusicService, type QueueItem } from '../src/music/music.service';
import { ConfigService } from '../src/common/config.service';

// Player, cola, votos de skip, radio y limpieza de VC con voz simulada.
// (Los tests de mapeo puro vivían aquí: siguen abajo, sin la capa de voz.)

class MockConfig extends ConfigService {
  store: Record<string, any> = { ytdl_sidecar_url: 'http://sidecar.test:7654' };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeNavidrome(over: Record<string, any> = {}) {
  return {
    getStreamUrl: vi.fn((id: string) => `http://navi.local/stream/${id}`),
    getCoverUrl: vi.fn((cid?: string) => (cid ? `http://navi.local/cover/${cid}` : null)),
    getSimilarSongs: vi.fn(async () => []),
    getRandomSongs: vi.fn(async () => [
      { id: 'n1', title: 'Random Song', artist: 'Rartist', album: 'Ralbum', coverArt: 'c1' },
    ]),
    ...over,
  } as any;
}

function makeService(nav = makeNavidrome()) {
  const svc = new MusicService(new MockConfig(), nav);
  const channel: any = { id: 'c1', type: ChannelType.GuildText, send: vi.fn(async () => {}) };
  const guild: any = { id: 'g1' };
  return { svc, nav, channel, guild };
}

function makeInteraction(over: Record<string, any> = {}) {
  const i: any = {
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    user: { id: 'voter1' },
    guildId: 'g1',
    member: { voice: { channelId: 'vc1' } },
    guild: null,
    channel: null,
    options: { getString: vi.fn() },
    ...over,
  };
  // Paridad discord.js: deferReply marca la interacción como diferida → followUp.
  i.deferReply = vi.fn(async () => { i.deferred = true; });
  return i;
}

describe('MusicService — mapeo puro (sin voz)', () => {
  it('songToItem mapea una canción Navidrome a QueueItem con stream/cover', () => {
    const { svc } = makeService();
    const item = svc.songToItem({ id: 's1', title: 'Canción', artist: 'Art', album: 'Disco', coverArt: 'c1' } as any);
    expect(item).toEqual({
      type: 'navidrome',
      url: 'http://navi.local/stream/s1',
      id: 's1',
      title: 'Canción',
      artist: 'Art',
      album: 'Disco',
      cover_url: 'http://navi.local/cover/c1',
    });
  });

  it('songToItem usa defaults para campos faltantes', () => {
    const { svc } = makeService();
    const item = svc.songToItem({ id: 's2' } as any);
    expect(item.title).toBe('Unknown');
    expect(item.artist).toBe('Unknown');
    expect(item.album).toBe('Unknown Album');
    expect(item.cover_url).toBeNull();
  });

  it('getNowPlaying devuelve null cuando no hay nada reproduciéndose', () => {
    const { svc } = makeService();
    expect(svc.getNowPlaying('guild-inexistente')).toBeNull();
  });
});

describe('MusicService — reproducción (voz fake)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    h.conns.clear();
  });

  it('playNext navidrome: consume cola, crea player, pre-buffer 5s y envía embed con cover', async () => {
    const { svc, channel, guild } = makeService();
    const item: QueueItem = {
      type: 'navidrome', url: 'http://127.0.0.1:9/audio', title: 'Song', artist: 'Artist', album: 'Album', cover_url: 'http://cover',
    };
    await svc.enqueueAndPlay(guild, channel, [item]);
    const playerMid = h.lastPlayer();
    expect(playerMid.play).not.toHaveBeenCalled(); // aún en pre-buffer

    await vi.advanceTimersByTimeAsync(6000);
    expect(playerMid.play).toHaveBeenCalledTimes(1);
    expect(svc.getNowPlaying('g1')).toBe('Artist - Song | Álbum: Album');
    const embedCall = channel.send.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.embeds);
    expect(embedCall).toBeTruthy();
    expect(embedCall.embeds[0].data.title).toBe('🎶 Reproduciendo ahora');
    expect(embedCall.embeds[0].data.thumbnail.url).toBe('http://cover');
  });

  it('playNext youtube: resuelve vía sidecar y notifica por texto (sin cover)', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ stream_url: 'http://127.0.0.1:9/yt', title: 'YT Title' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [{ type: 'youtube', url: 'https://youtu.be/abc' }]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock.mock.calls[0][0]).toContain('http://sidecar.test:7654/extract?url=');
    expect(svc.getNowPlaying('g1')).toBe('YT Title');
    const textCall = channel.send.mock.calls.map((c: any[]) => c[0]).find((a: any) => typeof a === 'string');
    expect(textCall).toBe('🎶 Reproduciendo ahora: **YT Title**');
  });

  it('sidecar falla → mensaje de error al canal, cola queda vacía y sin canción colgada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => 'blocked' })));
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [{ type: 'youtube', url: 'https://youtu.be/x' }]);
    await vi.advanceTimersByTimeAsync(2000);
    const texts = channel.send.mock.calls.map((c: any[]) => c[0]);
    expect(texts.some((t: any) => String(t).includes('Ocurrió un error al reproducir'))).toBe(true);
    expect(svc.getNowPlaying('g1')).toBeNull();
  });

  it('radio: cola vacía + modo radio → repone desde Navidrome (similar → random)', async () => {
    const { svc, nav, channel, guild } = makeService();
    svc.startRadioMode('g1');
    await svc.enqueueAndPlay(guild, channel, []); // playNext con radio y cola vacía
    await vi.advanceTimersByTimeAsync(6000);
    expect(nav.getSimilarSongs).toHaveBeenCalled();
    expect(nav.getRandomSongs).toHaveBeenCalled();
    expect(svc.getNowPlaying('g1')).toBe('Rartist - Random Song | Álbum: Ralbum');
    const radioMsg = channel.send.mock.calls.map((c: any[]) => c[0]).find((a: any) => String(a).includes('Radio'));
    expect(radioMsg).toContain('Añadidas 1 canciones en la cola');
  });

  it('skip: voto aislado, voto repetido rechazado y mayoría → stop', async () => {
    const { svc } = makeService();
    const s = (svc as any).state('g1');
    const player = { state: { status: 'playing' }, stop: vi.fn() };
    s.player = player;

    const guild = {
      id: 'g1',
      members: { me: { voice: { channelId: 'vc1' } } },
      channels: {
        cache: new Map([
          ['vc1', { members: new Map([['h1', { user: { bot: false } }], ['h2', { user: { bot: false } }], ['bot', { user: { bot: true } }]]) }],
        ]),
      },
    };
    // 2 humanos → mayoría = 2 votos.
    const i1 = makeInteraction({ guild, member: { voice: { channelId: 'vc1' } }, user: { id: 'v1' } });
    await svc.skip(i1);
    expect(i1.followUp).toHaveBeenCalledWith({ content: '🗳️ Voto registrado (1/2).', ephemeral: false });
    expect(player.stop).not.toHaveBeenCalled();

    // Voto repetido → rechazado.
    const iRepeat = makeInteraction({ guild, member: { voice: { channelId: 'vc1' } }, user: { id: 'v1' } });
    await svc.skip(iRepeat);
    expect(iRepeat.followUp).toHaveBeenCalledWith({ content: '¡Ya has votado para saltar!', ephemeral: true });

    // Voto 2 → mayoría alcanzada → stop.
    const i2 = makeInteraction({ guild, member: { voice: { channelId: 'vc1' } }, user: { id: 'v2' } });
    await svc.skip(i2);
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(i2.followUp).toHaveBeenCalledWith({ content: '⏭️ ¡Votación completada! Saltando canción.', ephemeral: false });
    expect(s.skipVotes.size).toBe(0);
  });

  it('skip sin nada reproduciéndose → aviso; fuera del canal del bot → rechazado', async () => {
    const { svc } = makeService();
    const i0 = makeInteraction();
    await svc.skip(i0);
    expect(i0.followUp).toHaveBeenCalledWith({ content: 'No hay nada reproduciéndose.', ephemeral: true });

    const s = (svc as any).state('g1');
    s.player = { state: { status: 'playing' }, stop: vi.fn() };
    const guild = { id: 'g1', members: { me: { voice: { channelId: 'vc1' } } }, channels: { cache: new Map() } };
    const i = makeInteraction({ guild, member: { voice: { channelId: 'otro-canal' } } });
    await svc.skip(i);
    expect(i.followUp).toHaveBeenCalledWith({ content: 'Debes estar en el mismo canal de voz para saltar.', ephemeral: true });
  });

  it('stop sin conexión → "No estoy conectado"; con conexión → destruye TODO el estado', async () => {
    // Sin conexión
    const a = makeService();
    const ia = makeInteraction();
    await a.svc.stop(ia);
    expect(ia.followUp).toHaveBeenCalledWith({ content: 'No estoy conectado.', ephemeral: false });

    // Con conexión + estado sucio
    const b = makeService();
    const conn = h.makeFakeConnection('g1');
    h.conns.set('g1', conn);
    const s = (b.svc as any).state('g1');
    const player = { state: { status: 'playing' }, stop: vi.fn() };
    const ffmpeg = { kill: vi.fn() };
    s.player = player;
    s.ffmpeg = ffmpeg;
    s.queue.push({ type: 'youtube', url: 'x' });
    s.currentSong = 'Vieja';

    await b.svc.stop(makeInteraction());
    expect(player.stop).toHaveBeenCalled();
    expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
    expect(conn.destroy).toHaveBeenCalled();
    expect(s.queue).toEqual([]);
    expect(s.player).toBeNull();
    expect(b.svc.getNowPlaying('g1')).toBeNull();
  });

  it('queueInfo: vacía → texto; con cola → embed estilo Navidrome (color, footer, thumbnail, truncado a 10)', async () => {
    const { svc } = makeService();
    const empty = makeInteraction();
    await svc.queueInfo(empty);
    expect(empty.reply).toHaveBeenCalledWith({ content: 'La cola está vacía.' });

    const s = (svc as any).state('g1');
    s.currentSong = 'A - Actual';
    s.currentAlbum = 'Disco';
    s.currentCoverUrl = 'http://cover';
    for (let i = 0; i < 12; i++) s.queue.push({ type: 'youtube', url: `u${i}`, title: `Tema ${i}` });
    const i = makeInteraction();
    await svc.queueInfo(i);
    const arg = i.reply.mock.calls[0][0];
    expect(arg.embeds).toHaveLength(1);
    const data = arg.embeds[0].data;
    expect(data.color).toBe(0x3498db);
    expect(data.footer.text).toBe('Hakkurei Music');
    expect(data.thumbnail.url).toBe('http://cover');
    expect(data.description).toContain('**Reproduciendo ahora:** A - Actual');
    expect(data.description).toContain('Tema 0');
    expect(data.description).toContain('...y 2 canciones más.');
  });

  it('checkEmptyVoiceChannels: desconecta tras la gracia de 5min con VC vacío', async () => {
    const { svc } = makeService();
    const conn = h.makeFakeConnection('g1');
    h.conns.set('g1', conn);
    const s = (svc as any).state('g1');
    s.player = { state: { status: 'playing' }, stop: vi.fn() };
    s.emptySince = Date.now() - 6 * 60 * 1000; // gracia vencida
    const client = {
      guilds: { cache: new Map([['g1', { id: 'g1', members: { me: { voice: { channelId: 'vc1' } } } }]]) },
      channels: { cache: new Map([['vc1', { members: new Map() }]]) },
    };
    await svc.checkEmptyVoiceChannels(client);
    expect(conn.destroy).toHaveBeenCalled();
    expect(s.player).toBeNull(); // resetPlaybackState
  });

  it('checkEmptyVoiceChannels: con humanos dentro no desconecta y resetea el timer', async () => {
    const { svc } = makeService();
    const conn = h.makeFakeConnection('g1');
    h.conns.set('g1', conn);
    const s = (svc as any).state('g1');
    s.emptySince = Date.now() - 6 * 60 * 1000;
    const client = {
      guilds: { cache: new Map([['g1', { members: { me: { voice: { channelId: 'vc1' } } } }]]) },
      channels: { cache: new Map([['vc1', { members: new Map([['h1', { user: { bot: false } }]]) }]]) },
    };
    await svc.checkEmptyVoiceChannels(client);
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(s.emptySince).toBeNull();
  });

  it('play (slash): une al VC si falta, encola y arranca; busy → solo encola', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => ({ stream_url: 'http://127.0.0.1:9/yt', title: 'YT' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { svc, channel, guild } = makeService();
    const vcRef = { id: 'vc1', guild: { voiceAdapterCreator: vi.fn() } };
    const interaction = makeInteraction({
      guild,
      channel,
      member: { voice: { channelId: 'vc1', channel: vcRef } },
    });
    const p = svc.play(interaction, 'https://youtu.be/abc');
    await vi.advanceTimersByTimeAsync(1500); // joinVC + estabilización 1s
    await p;
    expect(interaction.followUp).toHaveBeenCalledWith({ content: '▶️ Iniciando reproducción...', ephemeral: false });
    await vi.advanceTimersByTimeAsync(6000); // prebuffer del track
    expect(h.lastPlayer().play).toHaveBeenCalled();

    // Segundo /play con player ocupado → solo encola.
    (h.lastPlayer() as any).state.status = 'playing';
    const i2 = makeInteraction({
      deferred: true,
      guild,
      channel,
      member: { voice: { channelId: 'vc1', channel: vcRef } },
    });
    await svc.play(i2, 'https://youtu.be/segundo');
    expect(i2.followUp).toHaveBeenCalledWith({ content: '✅ Añadido a la cola: <https://youtu.be/segundo>', ephemeral: false });
    expect((svc as any).state('g1').queue).toHaveLength(1);
  });

  it('play sin estar en VC → aviso y no encola', async () => {
    const { svc } = makeService();
    const i = makeInteraction({ member: {} });
    await svc.play(i, 'https://youtu.be/x');
    expect(i.followUp).toHaveBeenCalledWith({
      content: '¡Necesitas estar en un canal de voz para que pueda poner música!', ephemeral: false,
    });
    expect((svc as any).state('g1').queue).toEqual([]);
  });
});

describe('MusicService — isIdle (para el auto-update del sidecar)', () => {
  afterEach(() => {
    h.conns.clear();
  });

  it('sin guilds ni actividad → idle', () => {
    const { svc } = makeService();
    expect(svc.isIdle()).toBe(true);
  });

  it('player no-Idle en algún guild → NO idle', () => {
    const { svc } = makeService();
    const s = (svc as any).state('g1');
    s.player = { state: { status: 'playing' }, stop: vi.fn(), play: vi.fn(), on: vi.fn() };
    expect(svc.isIdle()).toBe(false);
  });

  it('isFetching (extract en vuelo) → NO idle', () => {
    const { svc } = makeService();
    (svc as any).state('g2').isFetching = true;
    expect(svc.isIdle()).toBe(false);
  });
});

describe('MusicService — /stop hard-kill (epoch + abort + /reset sidecar)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    h.conns.clear();
  });

  it('/stop durante el extract → playNext aborta: sin player nuevo, sin ffmpeg, epoch++', async () => {
    let releaseFetch: (v: any) => void;
    const gate = new Promise((r) => (releaseFetch = r));
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/reset')) return { ok: true, json: async () => ({}) } as any;
      return gate;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [{ type: 'youtube', url: 'https://youtu.be/x' }]);
    const s = (svc as any).state('g1');
    expect(s.isFetching).toBe(true);
    const epochBefore = s.epoch;

    // /stop con el extract colgado: resetPlaybackState + POST /reset + abort.
    await svc.stop(makeInteraction({}));
    expect(s.epoch).toBe(epochBefore + 1);
    expect(s.player).toBeNull();
    expect(s.queue).toEqual([]);
    // El sidecar recibió POST /reset (matar proceso yt-dlp).
    expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes('/reset'))).toBe(true);

    // El extract por fin responde → la sesión vieja NO debe crear player/ffmpeg.
    releaseFetch({ ok: true, json: async () => ({ stream_url: 'http://127.0.0.1:9/x', title: 'T' }) });
    await vi.advanceTimersByTimeAsync(10000);
    expect(s.player).toBeNull();
    expect(s.ffmpeg).toBeNull();
    expect(s.currentSong).toBeNull();
  });

  it('/stop durante el pre-buffer → player.play nunca ocurre', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ stream_url: 'http://127.0.0.1:9/x', title: 'T' }),
    })));
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [{ type: 'navidrome', url: 'http://127.0.0.1:9/a', title: 'Song', artist: 'A', album: 'Al' }]);
    await vi.advanceTimersByTimeAsync(2000); // dentro del pre-buffer de 5s
    const player = h.lastPlayer();
    const s = (svc as any).state('g1');

    await svc.stop(makeInteraction({}));
    await vi.advanceTimersByTimeAsync(6000);
    expect(player.play).not.toHaveBeenCalled();
    expect(s.player).toBeNull();
    expect(s.currentSong).toBeNull();
  });

  it('extract con ECONNREFUSED (sidecar reiniciándose) → reintenta una vez a los 3s', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/reset')) return { ok: true, json: async () => ({}) } as any;
      const callNumber = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/extract')).length;
      if (callNumber === 1) {
        const err: any = new Error('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return { ok: true, json: async () => ({ stream_url: 'http://127.0.0.1:9/x', title: 'T' }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [{ type: 'youtube', url: 'https://youtu.be/x' }]);
    await vi.advanceTimersByTimeAsync(3500 + 6000); // retry 3s + prebuffer
    const extracts = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/extract'));
    expect(extracts).toHaveLength(2);
    expect((svc as any).state('g1').currentSong).toBe('T');
  });

  it('tras /stop la cola vieja no dispara la recursión de error del playNext abortado', async () => {
    // El finally del playNext abortado no debe pisar isFetching de una sesión nueva.
    let releaseFetch: (v: any) => void;
    const gate = new Promise((r) => (releaseFetch = r));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/reset')) return { ok: true, json: async () => ({}) } as any;
      return gate;
    }));
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [{ type: 'youtube', url: 'https://youtu.be/vieja' }]);
    await svc.stop(makeInteraction({}));
    releaseFetch({ ok: false, status: 502, text: async () => 'blocked' });
    await vi.advanceTimersByTimeAsync(2000);
    const s = (svc as any).state('g1');
    expect(s.isFetching).toBe(false); // resetPlaybackState lo dejó en false y el abortado no lo toca
    // Sin mensajes de error al canal: la sesión abortada es silenciosa.
    expect(channel.send).not.toHaveBeenCalled();
  });
});
