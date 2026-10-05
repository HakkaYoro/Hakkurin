export const TRACK_STARTED = 'music.track-started';

export class TrackStartedEvent {
  readonly event = TRACK_STARTED;
  constructor(
    readonly guildId: string,
    readonly title: string,
  ) {}
}
