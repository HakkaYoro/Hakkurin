import type { ChildProcess } from 'child_process';

export type ItemType = 'youtube' | 'navidrome';

export interface PlayerHandle {
  state: { status: string };
  play(resource: unknown): void;
  stop(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ConnectionHandle {
  subscribe(player: unknown): unknown;
  destroy(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ChannelHandle {
  send(content: unknown): Promise<unknown>;
}

/** Crudo aceptado por la factory; el shape serializado ({type,url,id,title,
 *  artist,album,cover_url}) es el contrato con music-ui y la persistencia. */
export interface QueueItemLike {
  type: ItemType;
  url?: string;
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover_url?: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export class QueueItemVo {
  private constructor(
    readonly type: ItemType,
    readonly url: string,
    readonly id: string | null,
    readonly title: string | null,
    readonly artist: string | null,
    readonly album: string | null,
    readonly cover_url: string | null,
  ) {}

  /** Validación: youtube exige url; navidrome exige id+url (defaults 'Unknown'
   *  para title/artist/album). null = item rechazado. */
  static from(raw: QueueItemLike | null | undefined): QueueItemVo | null {
    if (!raw) return null;
    const url = str(raw.url);
    const id = str(raw.id);
    if (raw.type === 'youtube') {
      if (!url) return null;
      return new QueueItemVo('youtube', url, id, str(raw.title), str(raw.artist), str(raw.album), str(raw.cover_url));
    }
    if (raw.type === 'navidrome') {
      if (!id || !url) return null;
      return new QueueItemVo(
        'navidrome', url, id,
        str(raw.title) ?? 'Unknown',
        str(raw.artist) ?? 'Unknown',
        str(raw.album) ?? 'Unknown Album',
        str(raw.cover_url),
      );
    }
    return null;
  }
}

export type VoteResult = 'counted' | 'passed' | 'duplicate';

const HISTORY_MAX = 5;

export class GuildMusicState {
  queue: QueueItemVo[] = [];
  currentSong: string | null = null;
  currentArtist = 'Unknown Artist';
  currentAlbum = 'Unknown Album';
  currentCoverUrl: string | null = null;
  skipVotes = new Set<string>();
  emptySince: number | null = null;
  playHistory: QueueItemVo[] = [];
  isRadioMode = false;
  radioPlayedIds = new Set<string>();
  isFetching = false;
  player: PlayerHandle | null = null;
  textChannel: ChannelHandle | null = null;
  ffmpeg: ChildProcess | null = null; // proceso ffmpeg del track actual; SIGKILL al cambiar/cortar
  fetchAbort: AbortController | null = null; // aborta el fetch al sidecar en vuelo
  // Generación del estado: resetEpoch la incrementa; playNext la captura al entrar
  // y la verifica tras CADA await. Si cambió, un /stop canceló la sesión y NO debe
  // crear ffmpeg/player sobre conexión muerta.
  epoch = 0;

  /** Ocupado = player en estado no-idle (Buffering/Playing; 'idle' es el literal
   *  de AudioPlayerStatus.Idle, comparado así para no importar el driver). */
  isBusy(): boolean {
    return !!this.player && this.player.state.status !== 'idle';
  }

  enqueue(item: QueueItemVo): void {
    this.queue.push(item);
  }

  /** Siguiente de la cola, archivado en el historial (máx 5, semilla de la radio). */
  popNext(): QueueItemVo | null {
    const item = this.queue.shift();
    if (!item) return null;
    this.playHistory.push(item);
    if (this.playHistory.length > HISTORY_MAX) this.playHistory.shift();
    return item;
  }

  enqueueRadio(items: QueueItemVo[]): number {
    let added = 0;
    for (const item of items) {
      if (!item.id || this.radioPlayedIds.has(item.id)) continue;
      this.radioPlayedIds.add(item.id);
      this.queue.push(item);
      added++;
    }
    return added;
  }

  startRadio(): void {
    this.isRadioMode = true;
    this.radioPlayedIds.clear();
  }

  stopRadio(): void {
    this.isRadioMode = false;
    this.radioPlayedIds.clear();
  }

  /** Pool de radio agotado → vaciarlo para permitir reciclar temas. */
  resetRadioPool(): void {
    this.radioPlayedIds.clear();
  }

  registerVote(userId: string, votesNeeded: number): VoteResult {
    if (this.skipVotes.has(userId)) return 'duplicate';
    this.skipVotes.add(userId);
    return this.skipVotes.size >= votesNeeded ? 'passed' : 'counted';
  }

  clearVotes(): void {
    this.skipVotes.clear();
  }

  /** Nueva generación: aborta el fetch en vuelo y limpia cola/radio/now-playing.
   *  No toca player/ffmpeg (drivers): los mata el caller vía AudioPipeline. */
  resetEpoch(): void {
    this.epoch += 1;
    if (this.fetchAbort) { try { this.fetchAbort.abort(); } catch {} this.fetchAbort = null; }
    this.queue = [];
    this.skipVotes.clear();
    this.isRadioMode = false;
    this.radioPlayedIds.clear();
    this.currentSong = null;
    this.currentCoverUrl = null;
    this.currentAlbum = 'Unknown Album';
    this.currentArtist = 'Unknown Artist';
    this.isFetching = false;
    this.textChannel = null;
  }

  /** Cola vacía: sin "now playing". */
  markIdle(): void {
    this.currentSong = null;
    this.currentCoverUrl = null;
  }

  /** Track en reproducción: actualiza el now-playing. */
  startTrack(guildId: string, item: QueueItemVo, resolvedTitle?: string): void {
    if (item.type === 'navidrome') {
      const title = item.title ?? 'Navidrome Stream';
      this.currentArtist = item.artist ?? 'Unknown Artist';
      this.currentAlbum = item.album ?? 'Unknown Album';
      this.currentSong = this.currentArtist !== 'Unknown Artist' ? `${this.currentArtist} - ${title}` : title;
      this.currentCoverUrl = item.cover_url;
    } else {
      this.currentSong = resolvedTitle ?? item.title ?? 'YouTube';
      this.currentCoverUrl = null;
    }
  }
}
