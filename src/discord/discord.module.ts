import { Module } from '@nestjs/common';
import { DiscordService } from './discord.service';
import { StealthDmService } from './stealth-dm.service';
import { SleepService } from './sleep.service';
import { SlashCommandsService } from './slash-commands.service';
import { ActionParserService } from '../scheduler/action-parser.service';
import { ConversationModule } from '../conversation/conversation.module';
import { MemoryModule } from '../memory/memory.module';
import { AiModule } from '../ai/ai.module';
import { MusicModule } from '../music/music.module';
import { NavidromeModule } from '../navidrome/navidrome.module';

@Module({
  imports: [ConversationModule, MemoryModule, AiModule, MusicModule, NavidromeModule],
  providers: [DiscordService, StealthDmService, SleepService, SlashCommandsService, ActionParserService],
  exports: [DiscordService],
})
export class DiscordModule {}
