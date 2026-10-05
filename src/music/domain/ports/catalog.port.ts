import type { SongVo } from '../../../navidrome/domain/song.vo';

export abstract class CatalogPort {
  abstract getSimilarSongs(ids: string[], n: number): Promise<SongVo[]>;
  abstract getRandomSongs(n: number): Promise<SongVo[]>;
  abstract getStreamUrl(id: string): string;
  abstract getCoverUrl(coverArt?: string): string | null;
}
