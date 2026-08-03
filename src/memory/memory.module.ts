import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { MemoryService } from './memory.service';

@Module({
  providers: [CryptoService, MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
