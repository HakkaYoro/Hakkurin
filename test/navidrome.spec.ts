import { vi } from 'vitest';
import { NavidromeAdapter } from '../src/navidrome/infrastructure/navidrome.adapter';
import { SongVo } from '../src/navidrome/domain/song.vo';
import { ConfigService } from '../src/common/config.service';
import { createHash } from 'crypto';

// Auth MD5-salt de Subsonic y armado de URLs de stream/cover: si el token o la
// query se arman mal, Navidrome rechaza todo. Validamos el algoritmo, el
// unwrapping de respuestas (→ SongVo) sin tocar la red real.

class MockConfig extends ConfigService {
  store: Record<string, any> = {
    navidrome_base_url: 'http://navi.local:30043/rest',
    navidrome_external_url: 'https://navi.example.com/rest',
    navidrome_username: 'hakkurin',
    navidrome_password: 'secretpass',
  };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeService(fetchImpl?: any): { svc: NavidromeAdapter; restore: () => void } {
  const original = global.fetch;
  if (fetchImpl) (global as any).fetch = fetchImpl;
  const svc = new NavidromeAdapter(new MockConfig());
  return { svc, restore: () => ((global as any).fetch = original) };
}

describe('SongVo — normalización defensiva del crudo Subsonic', () => {
  it('sin id (o no-objeto) → null; campos no-string/ vacíos → null', () => {
    expect(SongVo.from(null)).toBeNull();
    expect(SongVo.from('canción')).toBeNull();
    expect(SongVo.from({})).toBeNull();
    expect(SongVo.from({ id: '' })).toBeNull();
    expect(SongVo.from({ id: 42 })).toBeNull();

    const s = SongVo.from({ id: 's1', title: 'T', artist: '', album: 9, coverArt: 'c', extra: 'x' })!;
    expect(s.id).toBe('s1');
    expect(s.title).toBe('T');
    expect(s.artist).toBeNull();
    expect(s.album).toBeNull();
    expect(s.coverArt).toBe('c');
  });
});

describe('NavidromeAdapter — auth MD5-salt + URLs', () => {
  it('getStreamUrl arma /rest/stream con u, s (6), t=md5(password+salt)', () => {
    const { svc, restore } = makeService();
    const url = svc.getStreamUrl('mf1234');
    restore();
    const params = new URL(url).searchParams;
    expect(url).toContain('/rest/stream?');
    expect(params.get('u')).toBe('hakkurin');
    expect(params.get('s')).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(params.get('id')).toBe('mf1234');
    const expected = createHash('md5').update(`secretpass${params.get('s')}`).digest('hex');
    expect(params.get('t')).toBe(expected);
  });

  it('getCoverUrl(null/undefined) → null', () => {
    const { svc, restore } = makeService();
    expect(svc.getCoverUrl(undefined)).toBeNull();
    expect(svc.getCoverUrl('')).toBeNull();
    restore();
  });

  it('getCoverUrl usa external_url y size=500', () => {
    const { svc, restore } = makeService();
    const url = svc.getCoverUrl('co1');
    restore();
    expect(url).toContain('https://navi.example.com/rest/getCoverArt?');
    expect(new URL(url!).searchParams.get('size')).toBe('500');
    expect(new URL(url!).searchParams.get('id')).toBe('co1');
  });

  it('getCoverUrl cae a baseUrl si no hay external_url', () => {
    const cfg = new MockConfig();
    cfg.store.navidrome_external_url = '';
    const svc = new NavidromeAdapter(cfg);
    const url = svc.getCoverUrl('co1');
    expect(url).toContain('http://navi.local:30043/rest/getCoverArt?');
  });
});

describe('NavidromeAdapter — unwrapping de respuestas Subsonic', () => {
  it('search devuelve searchResult3 tipado (SongVo/álbumes/artistas)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        'subsonic-response': {
          searchResult3: {
            song: [{ id: 's1', title: 'T' }],
            album: [{ id: 'al1', name: 'Disco', artist: 'Artista', coverArt: 'c' }],
            artist: [{ id: 'ar1', name: 'Artista' }],
          },
        },
      }),
    });
    const { svc, restore } = makeService(fetchImpl);
    const res = await svc.search('foo');
    restore();
    expect(res.song).toHaveLength(1);
    expect(res.song[0]?.id).toBe('s1');
    expect(res.song[0]?.title).toBe('T');
    expect(res.album[0]?.id).toBe('al1');
    expect(res.album[0]?.name).toBe('Disco');
    expect(res.artist[0]?.name).toBe('Artista');
    expect(fetchImpl.mock.calls[0][0]).toContain('/rest/search3?');
  });

  it('getRandomSongs devuelve la lista randomSongs.song', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'subsonic-response': { randomSongs: { song: [{ id: 'a' }, { id: 'b' }] } } }),
    });
    const { svc, restore } = makeService(fetchImpl);
    const songs = await svc.getRandomSongs(2);
    restore();
    expect(songs.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('getSimilarSongs sin ids → cae a getRandomSongs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'subsonic-response': { randomSongs: { song: [{ id: 'r1' }] } } }),
    });
    const { svc, restore } = makeService(fetchImpl);
    const songs = await svc.getSimilarSongs([], 5);
    restore();
    expect(songs.map((s) => s.id)).toEqual(['r1']);
    // No debe haber llamado a getSimilarSongs2 (sin ids).
    expect(fetchImpl.mock.calls[0][0]).toContain('/rest/getRandomSongs?');
  });

  it('getAlbumSongs devuelve album.song', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'subsonic-response': { album: { song: [{ id: 'x' }] } } }),
    });
    const { svc, restore } = makeService(fetchImpl);
    const songs = await svc.getAlbumSongs('al1');
    restore();
    expect(songs.map((s) => s.id)).toEqual(['x']);
  });

  it('respuesta de error de red → listas vacías sin lanzar', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { svc, restore } = makeService(fetchImpl);
    await expect(svc.search('x')).resolves.toEqual({ song: [], album: [], artist: [] });
    await expect(svc.getRandomSongs(5)).resolves.toEqual([]);
    restore();
  });

  it('HTTP != 2xx → api devuelve null (search → vacío, álbum → [])', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const { svc, restore } = makeService(fetchImpl);
    await expect(svc.search('x')).resolves.toEqual({ song: [], album: [], artist: [] });
    await expect(svc.getAlbumSongs('al')).resolves.toEqual([]);
    restore();
  });

  it('sin navidrome_base_url → api corta antes de fetch', async () => {
    const cfg = new MockConfig();
    cfg.store.navidrome_base_url = '';
    const fetchImpl = vi.fn();
    const original = (global as any).fetch;
    (global as any).fetch = fetchImpl;
    const svc = new NavidromeAdapter(cfg);
    await expect(svc.getRandomSongs(5)).resolves.toEqual([]);
    (global as any).fetch = original;
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('NavidromeAdapter — radio por artista', () => {
  const SONGS = [
    { id: '1', artist: 'Radiohead' },
    { id: '2', artist: 'radiohead' }, // case-insensitive
    { id: '3', artist: 'Otro' },
  ];

  function makeWithSongs(songs: any[], count: number) {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'subsonic-response': { searchResult3: { song: songs } } }),
    });
    const { svc, restore } = makeService(fetchImpl);
    return { svc, restore, fetchImpl };
  }

  it('getArtistRadio filtra por artista (case-insensitive) y respeta el count', async () => {
    const { svc, restore, fetchImpl } = makeWithSongs(SONGS, 20);
    const out = await svc.getArtistRadio('radiohead', 20);
    restore();
    expect(out.map((s) => s.id).sort()).toEqual(['1', '2']);
    expect(fetchImpl.mock.calls[0][0]).toContain('songCount=100');
  });

  it('getArtistRadio: si ningún artista coincide → usa todas las canciones', async () => {
    const { svc, restore } = makeWithSongs(SONGS, 20);
    const out = await svc.getArtistRadio('nadie-existe', 2);
    restore();
    expect(out.length).toBe(2); // count aplica sobre el total
  });

  it('getSimilarSongs: similarSongs2 con canciones → las devuelve; vacío → random', async () => {
    // Con resultados
    const a = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'subsonic-response': { similarSongs2: { song: [{ id: 'sim1' }] } } }),
    });
    const sa = makeService(a);
    const similar = await sa.svc.getSimilarSongs(['base1'], 10);
    sa.restore();
    expect(similar).toHaveLength(1);
    expect(similar[0]?.id).toBe('sim1');
    expect(a.mock.calls[0][0]).toContain('/rest/getSimilarSongs2?');

    // Sin resultados → fallback a random
    const b = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'subsonic-response': { similarSongs2: {}, randomSongs: { song: [{ id: 'rnd' }] } } }),
    });
    const sb = makeService(b);
    const fallback = await sb.svc.getSimilarSongs(['base1'], 10);
    sb.restore();
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.id).toBe('rnd');
  });
});
