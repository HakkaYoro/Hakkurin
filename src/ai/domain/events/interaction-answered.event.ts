export const INTERACTION_ANSWERED = 'ai.interaction-answered';

export class InteractionAnsweredEvent {
  readonly event = INTERACTION_ANSWERED;
  constructor(
    readonly userId: string,
    readonly channelId: string,
    readonly replyText: string,
  ) {}
}
