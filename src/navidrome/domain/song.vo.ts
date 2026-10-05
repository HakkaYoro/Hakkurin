// Normalización defensiva: Navidrome a veces devuelve objeto suelto donde
// esperamos lista, o campos ausentes/no-string.

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export class SongVo {
  private constructor(
    readonly id: string,
    readonly title: string | null,
    readonly artist: string | null,
    readonly album: string | null,
    readonly coverArt: string | null,
  ) {}

  /** null si el crudo no sirve (sin id) — el caller filtra. */
  static from(raw: unknown): SongVo | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id) return null;
    return new SongVo(id, str(r.title), str(r.artist), str(r.album), str(r.coverArt));
  }
}

export class AlbumVo {
  private constructor(
    readonly id: string,
    readonly name: string | null,
    readonly artist: string | null,
    readonly coverArt: string | null,
  ) {}

  static from(raw: unknown): AlbumVo | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id) return null;
    return new AlbumVo(id, str(r.name), str(r.artist), str(r.coverArt));
  }
}

export class ArtistVo {
  private constructor(
    readonly id: string,
    readonly name: string | null,
  ) {}

  static from(raw: unknown): ArtistVo | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id) return null;
    return new ArtistVo(id, str(r.name));
  }
}

export interface SearchResult {
  song: SongVo[];
  album: AlbumVo[];
  artist: ArtistVo[];
}
