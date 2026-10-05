import { Module } from '@nestjs/common';
import { MusicService } from './application/music.service';
import { YtdlUpdaterService } from './infrastructure/ytdl-updater.service';
import { NavidromeModule } from '../navidrome/navidrome.module';
import { NavidromeService } from '../navidrome/infrastructure/navidrome.service';
import { SidecarClient } from './infrastructure/adapters/sidecar.client';
import { FfmpegAdapter } from './infrastructure/adapters/ffmpeg.adapter';
import { DiscordPresenter } from './infrastructure/adapters/music.presenter';
import { VoiceAdapter } from './infrastructure/adapters/voice.adapter';
import { AudioPipeline, MusicPresenter, StreamSource } from './domain/ports/music.ports';
import { CatalogPort } from './domain/ports/catalog.port';
import { VoiceConnectionPort } from './domain/ports/voice-connection.port';

@Module({
  imports: [NavidromeModule],
  providers: [
    SidecarClient, FfmpegAdapter, DiscordPresenter, VoiceAdapter,
    { provide: StreamSource, useExisting: SidecarClient },
    { provide: AudioPipeline, useExisting: FfmpegAdapter },
    { provide: MusicPresenter, useExisting: DiscordPresenter },
    { provide: VoiceConnectionPort, useExisting: VoiceAdapter },
    { provide: CatalogPort, useExisting: NavidromeService },
    MusicService, YtdlUpdaterService,
  ],
  exports: [MusicService],
})
export class MusicModule {}
