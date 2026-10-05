import { Module } from '@nestjs/common';
import { MusicService } from './music.service';
import { YtdlUpdaterService } from './ytdl-updater.service';
import { NavidromeModule } from '../navidrome/navidrome.module';

@Module({
  imports: [NavidromeModule],
  providers: [MusicService, YtdlUpdaterService],
  exports: [MusicService],
})
export class MusicModule {}
