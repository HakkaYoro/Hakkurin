export const MEMORY_APPENDED = 'memory.appended';

export class MemoryAppendedEvent {
  readonly event = MEMORY_APPENDED;
  constructor(readonly userId: string) {}
}
