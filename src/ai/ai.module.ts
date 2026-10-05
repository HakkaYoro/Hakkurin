import { Module } from '@nestjs/common';
import { GeminiAdapter } from './infrastructure/adapters/gemini.adapter';
import { ContextBuilderService } from './application/context-builder.service';
import { AiBrain } from './domain/ports/ai-brain.port';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [ContextBuilderService, { provide: AiBrain, useClass: GeminiAdapter }],
  exports: [AiBrain],
})
export class AiModule {}
