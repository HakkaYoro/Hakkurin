export const MEMORY_SUMMARY_CREATED = 'memory.summary-created';

export class MemorySummaryCreatedEvent {
  readonly event = MEMORY_SUMMARY_CREATED;
  constructor(readonly userId: string) {}
}
