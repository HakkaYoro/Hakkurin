import { Module } from '@nestjs/common';
import { DiscordModule } from '../discord/discord.module';
import { DiscordService } from '../discord/discord.service';
import { MemoryModule } from '../memory/memory.module';
import { AiModule } from '../ai/ai.module';
import { BOT_LIFECYCLE } from './bot-lifecycle.port';
import { WebController } from './web.controller';
import { ViewService } from './view.service';
import { AuthGuard } from './auth.guard';
import { LogTeeService } from './log-tee.service';

@Module({
  // AiModule exporta el token 'AiBrain' (recarga de keys en caliente desde update_config).
  imports: [DiscordModule, MemoryModule, AiModule],
  controllers: [WebController],
  providers: [
    ViewService,
    AuthGuard,
    LogTeeService, // registrado como logger global en main.ts (app.get + useLogger)
    // Puerto BotLifecycle → adaptador real (DiscordModule ya exporta DiscordService).
    { provide: BOT_LIFECYCLE, useExisting: DiscordService },
  ],
})
export class WebModule {}
