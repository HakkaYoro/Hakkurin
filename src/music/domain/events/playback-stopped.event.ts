export const PLAYBACK_STOPPED = 'music.playback-stopped';

export class PlaybackStoppedEvent {
  readonly event = PLAYBACK_STOPPED;
  constructor(readonly guildId: string) {}
}
