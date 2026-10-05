// El binding lo resuelve Nest por design:paramtypes sobre estas clases
// concretas; no hay tokens de inyección.

export abstract class EncryptorPort {
  abstract encrypt(plain: string): Buffer;
  abstract decrypt(data: Buffer): string;
}

export abstract class MemoryRepositoryPort {
  abstract init(): Promise<void>;
  /** JSON crudo descifrado; la normalización de esquema la aplica el dominio. */
  abstract getMemory(user_id: string): Promise<any>;
  /** Recibe YA normalizada → serializa+cifra atómicamente. */
  abstract saveMemory(user_id: string, data: any): Promise<void>;
  abstract saveSummaryPlaintext(user_id: string, text: string): Promise<void>;
  abstract listMemories(): Promise<{ user_id: string; date: string }[]>;
  abstract listUserIds(): Promise<string[]>;
  abstract deleteMemory(user_id: string): Promise<void>;
  abstract deleteAllMemories(): Promise<void>;
}

export abstract class MemoryQueuePort {
  /** Hook opcional; no-op por defecto para fakes de test. */
  init(): Promise<void> {
    return Promise.resolve();
  }
  abstract addToQueue(user_id: string, text: string): Promise<void>;
  abstract getQueuedInteractions(user_id: string): Promise<string[]>;
  abstract processQueue(promote: (userId: string, text: string) => Promise<boolean>): Promise<string[]>;
}
