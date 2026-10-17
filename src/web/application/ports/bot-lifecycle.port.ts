export interface BotStatus {
  connected: boolean;
  uptimeS: number;
  readySince: string | null;
  lastDisconnectAt: string | null;
}

export abstract class BotLifecycle {
  abstract forceShutdownAndSummarize(): Promise<void>;
  abstract restart(): Promise<void>;
  abstract getStatus(): BotStatus;
}
