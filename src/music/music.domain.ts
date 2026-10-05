// Dominio puro de música: item de cola, estado por guild y regla de ocupado.
// Puerto de bot/music_manager.py. Sin imports de discord.js/@discordjs/voice:
// los handles de player/conexión/canal se tipan estructuralmente (los tipos
// reales de los drivers los satisfacen). ponytail: el upgrade path si el
// dominio llegara a necesitar más tipos del driver es import type desde
// @discordjs/voice o discord.js.
import type { ChildProcess } from 'child_process';

export interface QueueItem {
  type: 'youtube' | 'navidrome';
  url: string;
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover_url?: string | null;
}

// Handles estructurales mínimos sobre los objetos de los drivers. AudioPlayer
// (play devuelve boolean, on viene de EventEmitter) y VoiceConnection los
// satisfacen tal cual; los fakes de test también.
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
  guild: any;
  send(content: unknown): Promise<unknown>;
}

export interface GuildMusicState {
  queue: QueueItem[];
  currentSong: string | null;
  currentArtist: string;
  currentAlbum: string;
  currentCoverUrl: string | null; // cover de la canción actual → thumbnail del embed de /queue
  skipVotes: Set<string>;
  emptySince: number | null;
  playHistory: QueueItem[];
  isRadioMode: boolean;
  radioPlayedIds: Set<string>;
  isFetching: boolean;
  player: PlayerHandle | null;
  connection: ConnectionHandle | null;
  textChannel: ChannelHandle | null;
  ffmpeg: ChildProcess | null; // proceso ffmpeg del track actual; SIGKILL al cambiar/cortar
}

export function newState(): GuildMusicState {
  return {
    queue: [],
    currentSong: null,
    currentArtist: 'Unknown Artist',
    currentAlbum: 'Unknown Album',
    currentCoverUrl: null,
    skipVotes: new Set(),
    emptySince: null,
    playHistory: [],
    isRadioMode: false,
    radioPlayedIds: new Set(),
    isFetching: false,
    player: null,
    connection: null,
    textChannel: null,
    ffmpeg: null,
  };
}

/**
 * Ocupado = hay player Y su estado no es Idle. Tras player.play() el player pasa
 * por Buffering antes de Playing; tratar cualquier estado no-Idle como ocupado
 * evita doble play / canción cortada (equivalente al is_playing() de discord.py,
 * que es true desde el instante de play()). isFetching cubre la ventana del await.
 */
export function isBusy(s: GuildMusicState): boolean {
  // 'idle' === AudioPlayerStatus.Idle (enum de strings en @discordjs/voice);
  // comparar el literal evita importar el driver en el dominio.
  return !!s.player && s.player.state.status !== 'idle';
}
