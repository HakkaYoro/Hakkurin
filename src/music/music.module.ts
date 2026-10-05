import { Module } from '@nestjs/common';
import { MusicService } from './application/music.service';
import { YtdlUpdaterService } from './infrastructure/ytdl-updater.service';
import { NavidromeModule } from '../navidrome/navidrome.module';
import { NavidromeAdapter } from '../navidrome/infrastructure/navidrome.adapter';
import { SidecarAdapter } from './infrastructure/adapters/sidecar.adapter';
import { FfmpegAdapter } from './infrastructure/adapters/ffmpeg.adapter';
import { DiscordPresenterAdapter } from './infrastructure/adapters/discord-presenter.adapter';
import { VoiceAdapter } from './infrastructure/adapters/voice.adapter';
import { AudioPipeline, MusicPresenter, StreamSource } from './domain/ports/music.ports';
import { CatalogPort } from './domain/ports/catalog.port';
import { VoiceConnectionPort } from './domain/ports/voice-connection.port';

@Module({
  imports: [NavidromeModule],
  providers: [
    SidecarAdapter, FfmpegAdapter, DiscordPresenterAdapter, VoiceAdapter,
    { provide: StreamSource, useExisting: SidecarAdapter },
    { provide: AudioPipeline, useExisting: FfmpegAdapter },
    { provide: MusicPresenter, useExisting: DiscordPresenterAdapter },
    { provide: VoiceConnectionPort, useExisting: VoiceAdapter },
    { provide: CatalogPort, useExisting: NavidromeAdapter },
    MusicService, YtdlUpdaterService,
  ],
  exports: [MusicService, CatalogPort],
})
export class MusicModule {}
