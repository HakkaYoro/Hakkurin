import { MusicService } from '../src/music/music.service';

// Voice requiere un cliente/guild real (se verifica en vivo). Aquí cubrimos la
// construcción de items de cola (songToItem, usado por radio + /search) y el
// shape del contexto "now playing" para el LLM.

describe('MusicService (construcción de items + now playing)', () => {
  function makeService() {
    const config = { get: (_k: string, d?: any) => d } as any;
    const navidrome = {
      getStreamUrl: (id: string) => `stream:${id}`,
      getCoverUrl: (id?: string) => (id ? `cover:${id}` : null),
    } as any;
    return new MusicService(config, navidrome);
  }

  it('songToItem mapea una canción Navidrome a QueueItem con stream/cover', () => {
    const svc = makeService();
    const item = svc.songToItem({ id: 's1', title: 'Canción', artist: 'Art', album: 'Disco', coverArt: 'c1' });
    expect(item).toEqual({
      type: 'navidrome',
      url: 'stream:s1',
      id: 's1',
      title: 'Canción',
      artist: 'Art',
      album: 'Disco',
      cover_url: 'cover:c1',
    });
  });

  it('songToItem usa defaults para campos faltantes', () => {
    const svc = makeService();
    const item = svc.songToItem({ id: 's2' });
    expect(item.title).toBe('Unknown');
    expect(item.artist).toBe('Unknown');
    expect(item.album).toBe('Unknown Album');
    expect(item.cover_url).toBeNull();
  });

  it('getNowPlaying devuelve null cuando no hay nada reproduciéndose', () => {
    const svc = makeService();
    expect(svc.getNowPlaying('guild-inexistente')).toBeNull();
  });
});
