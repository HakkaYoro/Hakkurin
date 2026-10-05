// Puerto de bot/navidrome_client.py. Cliente Subsonic REST con auth MD5-salt.
// Creds y URLs se leen del ConfigService (antes hardcoded en :9-13 — security fix).
// ponytail: respuestas tipadas como any; la API Subsonic es laxa y sobre-tiparla
// es ruido. Coercemos listas defensivamente (Navidrome a veces devuelve objeto suelto).
import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '../common/config.service';
import { shuffle, toArray } from '../common/util';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CLIENT_NAME = 'hakkurin-bot';
const VERSION = '1.16.1';

export interface NavidromeSong {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  coverArt?: string;
  [k: string]: any;
}

@Injectable()
export class NavidromeService {
  private readonly logger = new Logger(NavidromeService.name);

  constructor(private readonly config: ConfigService) {}

  private creds() {
    return {
      baseUrl: this.trimBase(this.config.get<string>('navidrome_base_url', '')),
      externalUrl: this.trimBase(this.config.get<string>('navidrome_external_url', '')),
      username: this.config.get<string>('navidrome_username', ''),
      password: this.config.get<string>('navidrome_password', ''),
    };
  }

  // Acepta la URL con o sin /rest; normalizamos a base sin trailing slash.
  private trimBase(url: string): string {
    return url.replace(/\/rest\/?$/, '').replace(/\/$/, '');
  }

  private authParams(): Record<string, string> {
    const { username, password } = this.creds();
    const salt = Array.from(randomBytes(6), (b) => CHARSET[b % CHARSET.length]).join('');
    const token = createHash('md5').update(`${password}${salt}`).digest('hex');
    return { u: username, t: token, s: salt, v: VERSION, c: CLIENT_NAME, f: 'json' };
  }

  private async api(path: string, extra: Record<string, string | number> = {}): Promise<any> {
    const { baseUrl } = this.creds();
    if (!baseUrl) return null;
    const params = new URLSearchParams({ ...this.authParams(), ...stringifyVals(extra) });
    try {
      const res = await fetch(`${baseUrl}/rest/${path}?${params}`);
      if (!res.ok) {
        this.logger.warn(`Navidrome ${path} HTTP ${res.status}`);
        return null;
      }
      return (await res.json())['subsonic-response'];
    } catch (e) {
      this.logger.warn(`Error Navidrome ${path}: ${(e as Error).message}`);
      return null;
    }
  }

  async search(query: string, limit = 5): Promise<any> {
    const data = await this.api('search3', { query, songCount: limit, albumCount: limit, artistCount: limit });
    return data?.searchResult3 ?? {};
  }

  async getArtistRadio(artistName: string, count = 20): Promise<NavidromeSong[]> {
    const data = await this.api('search3', { query: artistName, songCount: 100, albumCount: 0, artistCount: 0 });
    let songs: NavidromeSong[] = toArray(data?.searchResult3?.song);
    const filtered = songs.filter((s) => (s.artist ?? '').toLowerCase().includes(artistName.toLowerCase()));
    songs = filtered.length ? filtered : songs;
    return shuffle(songs).slice(0, count);
  }

  async getSimilarSongs(songIds: string[], count = 10): Promise<NavidromeSong[]> {
    if (!songIds.length) return this.getRandomSongs(count);
    const baseId = songIds[Math.floor(Math.random() * songIds.length)];
    const data = await this.api('getSimilarSongs2', { id: baseId, count });
    let songs = toArray(data?.similarSongs2?.song);
    if (!songs.length) return this.getRandomSongs(count); // Last.fm ausente → random
    return shuffle(songs).slice(0, count);
  }

  async getRandomSongs(count = 10): Promise<NavidromeSong[]> {
    const data = await this.api('getRandomSongs', { size: count });
    return toArray(data?.randomSongs?.song);
  }

  async getAlbumSongs(albumId: string): Promise<NavidromeSong[]> {
    const data = await this.api('getAlbum', { id: albumId });
    return toArray(data?.album?.song);
  }

  /** URL de stream (audio directo) — sincrónico, arma la query. */
  getStreamUrl(songId: string): string {
    const { baseUrl } = this.creds();
    const params = new URLSearchParams({ ...this.authParams(), id: songId });
    return `${baseUrl}/rest/stream?${params}`;
  }

  /** URL de carátula vía external_url (para embeds públicos). null si sin coverArt. */
  getCoverUrl(coverId?: string): string | null {
    if (!coverId) return null;
    const { externalUrl, baseUrl } = this.creds();
    const base = externalUrl || baseUrl;
    const params = new URLSearchParams({ ...this.authParams(), id: coverId, size: '500' });
    return `${base}/rest/getCoverArt?${params}`;
  }
}

function stringifyVals(o: Record<string, string | number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) out[k] = String(v);
  return out;
}
