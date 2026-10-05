export abstract class BotLifecycle {
  abstract forceShutdownAndSummarize(): Promise<void>;
  abstract restart(): Promise<void>;
}
