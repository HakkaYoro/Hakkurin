import { Module } from '@nestjs/common';
import { DiscordModule } from '../discord/discord.module';
import { DiscordAdapter } from '../discord/infrastructure/discord.adapter';
import { MemoryModule } from '../memory/memory.module';
import { AiModule } from '../ai/ai.module';
import { BotLifecycle } from './application/ports/bot-lifecycle.port';
import { WebController } from './infrastructure/web.controller';
import { ViewService } from './infrastructure/view.service';
import { AuthGuard } from './infrastructure/auth.guard';
import { LogTeeService } from './infrastructure/log-tee.service';

@Module({
  // AiModule exporta AiBrain: WebController recarga keys en caliente vía reloadConfig.
  imports: [DiscordModule, MemoryModule, AiModule],
  controllers: [WebController],
  providers: [
    ViewService,
    AuthGuard,
    LogTeeService, // registrado como logger global en main.ts (app.get + useLogger)
    // useExisting exige que un módulo importado exporte DiscordAdapter.
    { provide: BotLifecycle, useExisting: DiscordAdapter },
  ],
})
export class WebModule {}
