import { Module } from '@nestjs/common';
import { GeminiProvider } from './infrastructure/adapters/gemini.provider';
import { ContextBuilderService } from './application/context-builder.service';
import { AiBrain } from './domain/ports/ai-brain.port';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [ContextBuilderService, { provide: AiBrain, useClass: GeminiProvider }],
  exports: [AiBrain],
})
export class AiModule {}
