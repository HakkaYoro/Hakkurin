import { Module } from '@nestjs/common';
import { GeminiAdapter } from './infrastructure/adapters/gemini.adapter';
import { OpenRouterAdapter } from './infrastructure/adapters/openrouter.adapter';
import { RoutingBrain } from './application/routing-brain.service';
import { ContextBuilderService } from './application/context-builder.service';
import { AiBrain } from './domain/ports/ai-brain.port';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [
    ContextBuilderService,
    GeminiAdapter,
    OpenRouterAdapter,
    RoutingBrain,
    { provide: AiBrain, useClass: RoutingBrain },
  ],
  exports: [AiBrain],
})
export class AiModule {}
