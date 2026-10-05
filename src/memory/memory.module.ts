import { Module } from '@nestjs/common';
import { CryptoService } from './infrastructure/persistence/crypto.service';
import { MemoryQueue } from './infrastructure/persistence/memory.queue';
import { MemoryRepository } from './infrastructure/persistence/memory.repository';
import { EncryptorPort, MemoryQueuePort, MemoryRepositoryPort } from './domain/ports/memory.ports';
import { MemoryService } from './application/memory.service';
import { MemoryEventsListener } from './application/memory-events.listener';

// Los puertos deben estar bindados: MemoryService tipa su ctor con las abstract
// classes y Nest resuelve por el tipo declarado (no por la instancia concreta).
@Module({
  providers: [
    CryptoService,
    MemoryRepository,
    MemoryQueue,
    { provide: EncryptorPort, useExisting: CryptoService },
    { provide: MemoryRepositoryPort, useExisting: MemoryRepository },
    { provide: MemoryQueuePort, useExisting: MemoryQueue },
    MemoryService,
    MemoryEventsListener,
  ],
  exports: [MemoryService],
})
export class MemoryModule {}
