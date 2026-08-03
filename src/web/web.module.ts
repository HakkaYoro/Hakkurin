import { Module } from '@nestjs/common';
import { DiscordModule } from '../discord/discord.module';
import { MemoryModule } from '../memory/memory.module';
import { WebController } from './web.controller';
import { ViewService } from './view.service';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [DiscordModule, MemoryModule],
  controllers: [WebController],
  providers: [ViewService, AuthGuard],
})
export class WebModule {}
