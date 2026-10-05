import { Module } from '@nestjs/common';
import { CryptoAdapter } from './infrastructure/persistence/crypto.adapter';
import { MemoryQueueAdapter } from './infrastructure/persistence/memory-queue.adapter';
import { MemoryRepositoryAdapter } from './infrastructure/persistence/memory-repository.adapter';
import { EncryptorPort, MemoryQueuePort, MemoryRepositoryPort } from './domain/ports/memory.ports';
import { MemoryService } from './application/memory.service';
import { MemoryEventsListener } from './application/memory-events.listener';

// Los puertos deben estar bindados: MemoryService tipa su ctor con las abstract
// classes y Nest resuelve por el tipo declarado (no por la instancia concreta).
@Module({
  providers: [
    CryptoAdapter,
    MemoryRepositoryAdapter,
    MemoryQueueAdapter,
    { provide: EncryptorPort, useExisting: CryptoAdapter },
    { provide: MemoryRepositoryPort, useExisting: MemoryRepositoryAdapter },
    { provide: MemoryQueuePort, useExisting: MemoryQueueAdapter },
    MemoryService,
    MemoryEventsListener,
  ],
  exports: [MemoryService],
})
export class MemoryModule {}
