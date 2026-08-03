import { Module } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';
import { ConfigModule } from '../common/config.module';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [ConfigModule, MemoryModule],
  providers: [{ provide: 'AiBrain', useClass: GeminiProvider }],
  exports: ['AiBrain'],
})
export class AiModule {}
