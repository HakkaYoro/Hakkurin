export abstract class BotStatePort {
  abstract updateBotStatus(
    statusType?: 'online' | 'idle' | 'dnd',
    activityText?: string,
  ): Promise<void>;
  abstract setLastActiveChannel(channelId: string): void;
  abstract performMemorySummarization(userId: string): Promise<void>;
}
