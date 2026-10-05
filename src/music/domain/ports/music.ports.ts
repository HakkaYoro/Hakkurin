import type { ChannelHandle, GuildMusicState, PlayerHandle, QueueItemVo } from '../music.domain';

export abstract class StreamSource {
  abstract resolve(item: QueueItemVo, signal?: AbortSignal): Promise<{ streamUrl: string; title?: string }>;
  /** No-op por defecto; el adaptador sidecar lo sobreescribe (POST /reset anti-zombie). */
  reset(): void {}
}

export abstract class AudioPipeline {
  /** Spawn de ffmpeg + recurso de audio + player.play (con pre-buffer
   *  anti-stutter antes del play). false si no pudo o el track fue abortado. */
  abstract createAndPlay(s: GuildMusicState, streamUrl: string, player: PlayerHandle): Promise<boolean>;
  abstract killCurrent(s: GuildMusicState): void;
}

export abstract class MusicPresenter {
  abstract nowPlaying(channel: ChannelHandle, title: string, coverUrl: string | null): Promise<void>;
  abstract radioAdded(channel: ChannelHandle, count: number): Promise<void>;
  abstract playbackError(channel: ChannelHandle, message: string): Promise<void>;
}
