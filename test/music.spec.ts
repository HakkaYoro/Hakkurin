import { vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { MusicService } from '../src/music/application/music.service';
import { QueueItemVo } from '../src/music/domain/music.domain';
import { SidecarAdapter } from '../src/music/infrastructure/adapters/sidecar.adapter';
import { FfmpegAdapter } from '../src/music/infrastructure/adapters/ffmpeg.adapter';
import { DiscordPresenterAdapter } from '../src/music/infrastructure/adapters/discord-presenter.adapter';
import { ConfigService } from '../src/common/config.service';

// Fakes: VoiceConnectionPort y CatalogPort. El StreamSource real (SidecarAdapter)
// corre contra fetch stubbed y el AudioPipeline real (FfmpegAdapter) contra
// child_process mockeado — determinista y sin audio ni red real.
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const { vi: v } = await import('vitest');
  return {
    spawn: v.fn(() => {
      const proc: any = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = v.fn();
      return proc;
    }),
  };
});

// Player, cola, votos de skip, radio y limpieza de VC con voz simulada.

class MockConfig extends ConfigService {
  store: Record<string, any> = { ytdl_sidecar_url: 'http://sidecar.test:7654' };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeCatalog(over: Record<string, any> = {}) {
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

function makeFakeVoice(over: Record<string, any> = {}) {
  const conns = new Map<string, any>();
  const players: any[] = [];
  const lost: Record<string, ((why: string) => void) | undefined> = {};
  const voice: any = {
    ensureConnection: vi.fn(async (gid: string, _vc: any, onLost?: (why: string) => void) => {
      const conn = { guildId: gid, subscribe: vi.fn(), destroy: vi.fn(), on: vi.fn() };
      conns.set(gid, conn);
      lost[gid] = onLost;
      return conn;
    }),
    createPlayer: vi.fn((_gid: string, _onIdle: () => void) => {
      const player = { state: { status: 'idle' }, play: vi.fn(), stop: vi.fn(), on: vi.fn() };
      players.push(player);
      return player;
    }),
    isConnected: vi.fn((gid: string) => conns.has(gid)),
    activeChannelId: vi.fn((gid: string) => (conns.has(gid) ? (over.activeChannelId ?? 'vc1') : null)),
    destroyConnection: vi.fn((gid: string, _why: string) => {
      const c = conns.get(gid);
      c?.destroy?.();
      conns.delete(gid);
    }),
    humansInVoice: vi.fn(async (_gid: string, _cid: string) => over.humans ?? []),
    setClient: vi.fn(),
  };
  return { voice, conns, players, lost };
}

function makeService(catalog = makeCatalog(), voiceOver: Record<string, any> = {}) {
  const config = new MockConfig();
  const { voice, conns, players, lost } = makeFakeVoice(voiceOver);
  const svc = new MusicService(config, catalog, new SidecarAdapter(config), new FfmpegAdapter(), new DiscordPresenterAdapter(), voice);
  const channel: any = { id: 'c1', type: ChannelType.GuildText, send: vi.fn(async () => {}) };
  const guild: any = { id: 'g1' };
  return { svc, catalog, voice, conns, players, lost, channel, guild };
}

const q = (raw: any): QueueItemVo => QueueItemVo.from(raw)!;

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
  it('songToItem mapea una canción Navidrome a QueueItemVo con stream/cover', () => {
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
  });

  it('playNext navidrome: consume cola, crea player, pre-buffer 5s y envía embed con cover', async () => {
    const { svc, channel, guild } = makeService();
    const item = q({
      type: 'navidrome', id: 'n9', url: 'http://127.0.0.1:9/audio', title: 'Song', artist: 'Artist', album: 'Album', cover_url: 'http://cover',
    });
    await svc.enqueueAndPlay(guild, channel, [item]);
    const playerMid = (svc as any).state('g1').player;
    expect(playerMid).toBeTruthy();
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
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/abc' })]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock.mock.calls[0][0]).toContain('http://sidecar.test:7654/extract?url=');
    expect(svc.getNowPlaying('g1')).toBe('YT Title');
    const textCall = channel.send.mock.calls.map((c: any[]) => c[0]).find((a: any) => typeof a === 'string');
    expect(textCall).toBe('🎶 Reproduciendo ahora: **YT Title**');
  });

  it('sidecar falla → mensaje de error al canal, cola queda vacía y sin canción colgada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => 'blocked' })));
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/x' })]);
    await vi.advanceTimersByTimeAsync(2000);
    const texts = channel.send.mock.calls.map((c: any[]) => c[0]);
    expect(texts.some((t: any) => String(t).includes('Ocurrió un error al reproducir'))).toBe(true);
    expect(svc.getNowPlaying('g1')).toBeNull();
  });

  it('radio: cola vacía + modo radio → repone desde Navidrome (similar → random)', async () => {
    const { svc, catalog, channel, guild } = makeService();
    svc.startRadioMode('g1');
    await svc.enqueueAndPlay(guild, channel, []); // playNext con radio y cola vacía
    await vi.advanceTimersByTimeAsync(6000);
    expect(catalog.getSimilarSongs).toHaveBeenCalled();
    expect(catalog.getRandomSongs).toHaveBeenCalled();
    expect(svc.getNowPlaying('g1')).toBe('Rartist - Random Song | Álbum: Ralbum');
    const radioMsg = channel.send.mock.calls.map((c: any[]) => c[0]).find((a: any) => String(a).includes('Radio'));
    expect(radioMsg).toContain('Añadidas 1 canciones en la cola');
  });

  it('skip: voto aislado, voto repetido rechazado y mayoría → stop', async () => {
    const { svc, voice } = makeService(undefined, { humans: [{ id: 'h1' }, { id: 'h2' }] });
    await voice.ensureConnection('g1', { id: 'vc1', guild: {} }); // el canal del bot viene del puerto
    const s = (svc as any).state('g1');
    const player = { state: { status: 'playing' }, stop: vi.fn() };
    s.player = player;

    // 2 humanos → mayoría = 2 votos.
    const i1 = makeInteraction({ member: { voice: { channelId: 'vc1' } }, user: { id: 'v1' } });
    await svc.skip(i1);
    expect(voice.humansInVoice).toHaveBeenCalledWith('g1', 'vc1');
    expect(i1.followUp).toHaveBeenCalledWith({ content: '🗳️ Voto registrado (1/2).', ephemeral: false });
    expect(player.stop).not.toHaveBeenCalled();

    // Voto repetido → rechazado.
    const iRepeat = makeInteraction({ member: { voice: { channelId: 'vc1' } }, user: { id: 'v1' } });
    await svc.skip(iRepeat);
    expect(iRepeat.followUp).toHaveBeenCalledWith({ content: '¡Ya has votado para saltar!', ephemeral: true });

    // Voto 2 → mayoría alcanzada → stop.
    const i2 = makeInteraction({ member: { voice: { channelId: 'vc1' } }, user: { id: 'v2' } });
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
    const i = makeInteraction({ member: { voice: { channelId: 'otro-canal' } } });
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
    await b.voice.ensureConnection('g1', { id: 'vc1', guild: {} });
    const conn = b.conns.get('g1');
    const s = (b.svc as any).state('g1');
    const player = { state: { status: 'playing' }, stop: vi.fn() };
    const ffmpeg = { kill: vi.fn() };
    s.player = player;
    s.ffmpeg = ffmpeg;
    s.enqueue(q({ type: 'youtube', url: 'x' }));
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
    for (let i = 0; i < 12; i++) s.enqueue(q({ type: 'youtube', url: `u${i}`, title: `Tema ${i}` }));
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
    const { svc, voice, conns } = makeService();
    await voice.ensureConnection('g1', { id: 'vc1', guild: {} });
    const conn = conns.get('g1');
    const s = (svc as any).state('g1');
    s.player = { state: { status: 'playing' }, stop: vi.fn() };
    s.emptySince = Date.now() - 6 * 60 * 1000; // gracia vencida
    const client = { isReady: () => true };
    await svc.checkEmptyVoiceChannels(client);
    expect(voice.setClient).toHaveBeenCalledWith(client);
    expect(conn.destroy).toHaveBeenCalled();
    expect(s.player).toBeNull(); // resetPlaybackState
  });

  it('checkEmptyVoiceChannels: con humanos dentro no desconecta y resetea el timer', async () => {
    const { svc, voice, conns } = makeService(undefined, { humans: [{ id: 'h1' }] });
    await voice.ensureConnection('g1', { id: 'vc1', guild: {} });
    const conn = conns.get('g1');
    const s = (svc as any).state('g1');
    s.emptySince = Date.now() - 6 * 60 * 1000;
    await svc.checkEmptyVoiceChannels({ isReady: () => true });
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
    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(interaction.followUp).toHaveBeenCalledWith({ content: '▶️ Iniciando reproducción...', ephemeral: false });
    await vi.advanceTimersByTimeAsync(6000); // prebuffer del track
    expect((svc as any).state('g1').player.play).toHaveBeenCalled();

    // Segundo /play con player ocupado → solo encola.
    (svc as any).state('g1').player.state.status = 'playing';
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

  it('conexión perdida irrecuperable (onLost) → kill ffmpeg + descarta player', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ stream_url: 'http://127.0.0.1:9/x', title: 'T' }),
    })));
    const { svc, voice, conns, players, lost, channel, guild } = makeService();
    // El cableado real lo hace joinVoice; aquí registramos su handler a mano.
    await voice.ensureConnection('g1', { id: 'vc1', guild: {} }, (why: string) => (svc as any).onVoiceLost('g1', why));
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/x' })]);
    await vi.advanceTimersByTimeAsync(1000);
    const s = (svc as any).state('g1');
    const player = s.player;
    const ffmpeg = s.ffmpeg;
    expect(ffmpeg).toBeTruthy();

    // El adapter notifica la pérdida (EndpointRemoved / reconexión falló).
    lost['g1']?.('desconexión irrecuperable');
    expect(conns.get('g1')?.destroy).not.toHaveBeenCalled(); // la destruye el adapter, no el callback
    expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
    expect(s.ffmpeg).toBeNull();
    expect(player.stop).toHaveBeenCalled();
    expect(s.player).toBeNull();
    expect(players).toHaveLength(1); // player nuevo sólo al reproducir de nuevo (re-bind)
  });
});

describe('MusicService — isIdle (para el auto-update del sidecar)', () => {
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
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/x' })]);
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
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'navidrome', id: 'n1', url: 'http://127.0.0.1:9/a', title: 'Song', artist: 'A', album: 'Al' })]);
    await vi.advanceTimersByTimeAsync(2000); // dentro del pre-buffer de 5s
    const player = (svc as any).state('g1').player;
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
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/x' })]);
    await vi.advanceTimersByTimeAsync(3500 + 6000); // retry 3s + prebuffer
    const extracts = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/extract'));
    expect(extracts).toHaveLength(2);
    expect((svc as any).state('g1').currentSong).toBe('T');
  });

  it('extract con sidecar caído >3s (post-update) → 3er intento a los 15s salva', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/reset')) return { ok: true, json: async () => ({}) } as any;
      const n = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/extract')).length;
      if (n <= 2) {
        const err: any = new Error('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return { ok: true, json: async () => ({ stream_url: 'http://127.0.0.1:9/x', title: 'T' }) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/x' })]);
    await vi.advanceTimersByTimeAsync(15000 + 6000); // retries 3s + 12s + prebuffer
    const extracts = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/extract'));
    expect(extracts).toHaveLength(3);
    expect((svc as any).state('g1').currentSong).toBe('T');
  });

  it('tras /stop la sesión abortada es silenciosa y un /play NUEVO funciona normal', async () => {
    // El playNext abortado (epoch viejo) no envía errores ni recurre; el epoch
    // check post-resolve lo corta antes de crear ffmpeg/player.
    let releaseFetch: (v: any) => void;
    const gate = new Promise((r) => (releaseFetch = r));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/reset')) return { ok: true, json: async () => ({}) } as any;
      return gate;
    }));
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/vieja' })]);
    await svc.stop(makeInteraction({}));
    await vi.advanceTimersByTimeAsync(2000);
    const s = (svc as any).state('g1');
    expect(s.isFetching).toBe(false);
    expect(channel.send).not.toHaveBeenCalled(); // la sesión abortada es silenciosa (abort, no error)

    // Un /play después del stop: sesión nueva (epoch distinto) reproduce normal.
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/nueva' })]);
    expect(s.isFetching).toBe(true); // la sesión nueva gestiona su flag
    releaseFetch({ ok: true, json: async () => ({ stream_url: 'http://127.0.0.1:9/n', title: 'Nueva' }) });
    await vi.advanceTimersByTimeAsync(6000);
    expect((svc as any).state('g1').currentSong).toBe('Nueva');
    expect(s.isFetching).toBe(false);
  });
});

describe('SidecarAdapter — precedencia de URL (env > config > default)', () => {
  afterEach(() => {
    delete process.env.YTDL_SIDECAR_URL;
    vi.unstubAllGlobals();
  });

  it('env YTDL_SIDECAR_URL manda sobre ytdl_sidecar_url del config (compose)', async () => {
    process.env.YTDL_SIDECAR_URL = 'http://sidecar:7654';
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ stream_url: 'http://127.0.0.1:9/x', title: 'T' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { svc, channel, guild } = makeService();
    await svc.enqueueAndPlay(guild, channel, [q({ type: 'youtube', url: 'https://youtu.be/x' })]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('http://sidecar:7654/extract');
  });
});

describe('FfmpegAdapter — contrato createAndPlay/killCurrent (spawn fake)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('killCurrent durante el pre-buffer → devuelve false y nunca hace play', async () => {
    const adapter = new FfmpegAdapter();
    const s: any = { ffmpeg: null };
    const player = { state: { status: 'idle' }, play: vi.fn(), stop: vi.fn(), on: vi.fn() };

    const p = adapter.createAndPlay(s, 'http://127.0.0.1:9/x', player);
    const ff = s.ffmpeg;
    expect(ff).toBeTruthy(); // spawn (fake) registrado en el estado
    await vi.advanceTimersByTimeAsync(2000);
    adapter.killCurrent(s); // simula /stop durante el pre-buffer
    expect(ff.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
    expect(s.ffmpeg).toBeNull();
  });

  it('sin abort: tras el pre-buffer hace play y killCurrent mata el proceso', async () => {
    const adapter = new FfmpegAdapter();
    const s: any = { ffmpeg: null };
    const player = { state: { status: 'idle' }, play: vi.fn(), stop: vi.fn(), on: vi.fn() };
    const p = adapter.createAndPlay(s, 'http://127.0.0.1:9/x', player);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toBe(true);
    expect(player.play).toHaveBeenCalledTimes(1);
    const ff = s.ffmpeg;
    adapter.killCurrent(s);
    expect(ff.kill).toHaveBeenCalledWith('SIGKILL');
    expect(s.ffmpeg).toBeNull();
  });

  it('streamUrl vacío → false sin spawn ni play', async () => {
    const adapter = new FfmpegAdapter();
    const s: any = { ffmpeg: null };
    const player = { state: { status: 'idle' }, play: vi.fn(), stop: vi.fn(), on: vi.fn() };
    expect(await adapter.createAndPlay(s, '', player)).toBe(false);
    expect(s.ffmpeg).toBeNull();
    expect(player.play).not.toHaveBeenCalled();
  });
});
