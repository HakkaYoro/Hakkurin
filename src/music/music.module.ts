import { Module } from '@nestjs/common';
import { MusicService } from './music.service';
import { NavidromeModule } from '../navidrome/navidrome.module';

@Module({
  imports: [NavidromeModule],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
