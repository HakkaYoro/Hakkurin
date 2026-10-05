import type { SongVo, SearchResult } from '../../../navidrome/domain/song.vo';

export abstract class CatalogPort {
  abstract search(query: string, limit?: number): Promise<SearchResult>;
  abstract getAlbumSongs(albumId: string): Promise<SongVo[]>;
  abstract getArtistRadio(artistName: string, count?: number): Promise<SongVo[]>;
  abstract getSimilarSongs(ids: string[], n: number): Promise<SongVo[]>;
  abstract getRandomSongs(n: number): Promise<SongVo[]>;
  abstract getStreamUrl(id: string): string;
  abstract getCoverUrl(coverArt?: string): string | null;
}
