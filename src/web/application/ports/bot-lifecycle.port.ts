export interface BotStatus {
  connected: boolean;
  uptimeS: number;
  readySince: string | null;
  lastDisconnectAt: string | null;
}

export interface MemberInfo {
  id: string;
  name: string; // displayName: nickname del servidor o username global
  avatarUrl: string | null;
}

export abstract class BotLifecycle {
  abstract forceShutdownAndSummarize(): Promise<void>;
  abstract restart(): Promise<void>;
  abstract getStatus(): BotStatus;
  abstract getMemberInfo(userId: string): Promise<MemberInfo | null>;
}
