import { Module } from '@nestjs/common';
import { DiscordService } from './discord.service';
import { SmartResponseService } from './smart-response.service';
import { ReminderService } from './reminder.service';
import { HolidayService } from './holiday.service';
import { StealthDmService } from './stealth-dm.service';
import { SleepService } from './sleep.service';
import { SlashCommandsService } from './slash-commands.service';
import { MusicUiService } from './music-ui.service';
import { ActionParserService } from '../scheduler/action-parser.service';
import { ConversationModule } from '../conversation/conversation.module';
import { MemoryModule } from '../memory/memory.module';
import { AiModule } from '../ai/ai.module';
import { MusicModule } from '../music/music.module';
import { NavidromeModule } from '../navidrome/navidrome.module';

@Module({
  imports: [ConversationModule, MemoryModule, AiModule, MusicModule, NavidromeModule],
  providers: [
    // Use-cases de DiscordService (hexagonal): respuesta, recordatorios, festividades.
    SmartResponseService,
    ReminderService,
    HolidayService,
    DiscordService,
    StealthDmService,
    SleepService,
    // Slash commands + vista de búsqueda de Navidrome.
    SlashCommandsService,
    MusicUiService,
    ActionParserService,
  ],
  exports: [DiscordService],
})
export class DiscordModule {}
