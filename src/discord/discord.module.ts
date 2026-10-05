import { Module } from '@nestjs/common';
import { DiscordAdapter } from './infrastructure/discord.adapter';
import { SmartResponseService } from './application/smart-response.service';
import { ReminderService } from './application/reminder.service';
import { HolidayService } from './application/holiday.service';
import { StealthDmService } from './application/stealth-dm.service';
import { SleepService } from './application/sleep.service';
import { SlashCommandsService } from './infrastructure/slash-commands.service';
import { MusicUiService } from './infrastructure/music-ui.service';
import { UrlEnricherAdapter } from './infrastructure/url-enricher.adapter';
import { HolidayStoreAdapter } from './infrastructure/persistence/holiday-store.adapter';
import { SleepStoreAdapter } from './infrastructure/persistence/sleep-store.adapter';
import { ActionParserService } from '../scheduler/application/action-parser.service';
import { ConversationModule } from '../conversation/conversation.module';
import { MemoryModule } from '../memory/memory.module';
import { AiModule } from '../ai/ai.module';
import { MusicModule } from '../music/music.module';
import { NavidromeModule } from '../navidrome/navidrome.module';
import { BotStatePort } from './domain/ports/bot-state.port';
import { HolidayStorePort } from './domain/ports/json-store.port';
import { MessageTransportPort } from './domain/ports/message-transport.port';
import { SleepStorePort } from './domain/ports/json-store.port';
import { UrlEnricherPort } from './domain/ports/url-enricher.port';

@Module({
  imports: [ConversationModule, MemoryModule, AiModule, MusicModule, NavidromeModule],
  providers: [
    SmartResponseService,
    ReminderService,
    HolidayService,
    StealthDmService,
    SleepService,
    UrlEnricherAdapter,
    HolidayStoreAdapter,
    SleepStoreAdapter,
    SlashCommandsService,
    MusicUiService,
    ActionParserService,
    DiscordAdapter,
    { provide: MessageTransportPort, useExisting: DiscordAdapter },
    { provide: BotStatePort, useExisting: DiscordAdapter },
    { provide: UrlEnricherPort, useExisting: UrlEnricherAdapter },
    { provide: HolidayStorePort, useExisting: HolidayStoreAdapter },
    { provide: SleepStorePort, useExisting: SleepStoreAdapter },
  ],
  exports: [DiscordAdapter],
})
export class DiscordModule {}
