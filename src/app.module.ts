import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from './common/config.module';
import { MemoryModule } from './memory/memory.module';
import { AiModule } from './ai/ai.module';
import { ConversationModule } from './conversation/conversation.module';
import { DiscordModule } from './discord/discord.module';
import { WebModule } from './web/web.module';

// ponytail: los @Interval(60000) de Phase 6 viven directamente como métodos en
// DiscordService (ya inyecta music+client); ScheduleModule.forRoot() los activa.
// No hace falta un SchedulerModule/SchedulerService aparte: serían puro delegado.
@Module({
  imports: [
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ConfigModule,
    MemoryModule,
    AiModule,
    ConversationModule,
    DiscordModule,
    WebModule,
  ],
})
export class AppModule {}
