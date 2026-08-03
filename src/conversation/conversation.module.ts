import { Module } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { AiModule } from '../ai/ai.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [AiModule, MemoryModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
