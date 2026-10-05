// Puertos hexagonales del módulo de música: el use-case (MusicService) depende de
// estas interfaces, no de los adaptadores concretos (sidecar HTTP, ffmpeg spawn,
// envío a Discord). import type de los drivers permitido aquí: los puertos
// describen el borde, el dominio (music.domain.ts) sigue puro.
import type { AudioResource } from '@discordjs/voice';
import type { TextChannel } from 'discord.js';
import type { GuildMusicState, QueueItem } from './music.domain';

/** Resolución de la URL de stream de un item (sidecar yt-dlp / Navidrome directo). */
export interface StreamSource {
  resolve(item: QueueItem, signal?: AbortSignal): Promise<{ streamUrl: string; title?: string }>;
}

/** Creación del AudioResource (ffmpeg) y corte del proceso del track actual. */
export interface AudioPipeline {
  create(s: GuildMusicState, streamUrl: string): AudioResource | null;
  killCurrent(s: GuildMusicState): void;
}

/** Mensajes de playback al canal de texto del guild. */
export interface MusicPresenter {
  nowPlaying(channel: TextChannel, title: string, coverUrl: string | null): Promise<void>;
  radioAdded(channel: TextChannel, count: number): Promise<void>;
  playbackError(channel: TextChannel, message: string): Promise<void>;
}
