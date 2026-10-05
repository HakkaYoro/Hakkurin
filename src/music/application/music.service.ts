import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
// ponytail: la superficie de comandos usa DTOs de discord.js (interactions, Guild,
// EmbedBuilder); upgrade: command DTOs propios en una capa de aplicación.
import { ConfigService } from '../../common/config.service';
import type { SongVo } from '../../navidrome/domain/song.vo';
import {
  GuildMusicState,
  QueueItemVo,
  type ChannelHandle,
  type PlayerHandle,
} from '../domain/music.domain';
import { AudioPipeline, MusicPresenter, StreamSource } from '../domain/ports/music.ports';
import { CatalogPort } from '../domain/ports/catalog.port';
import { VoiceConnectionPort, type VoiceChannelRef } from '../domain/ports/voice-connection.port';

export type { QueueItemVo } from '../domain/music.domain';

const EMPTY_VC_GRACE_MS = 5 * 60 * 1000;

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);
  private readonly guilds = new Map<string, GuildMusicState>();

  constructor(
    private readonly config: ConfigService,
    @Inject(CatalogPort) private readonly catalog: CatalogPort,
    @Inject(StreamSource) private readonly source: StreamSource,
    @Inject(AudioPipeline) private readonly pipeline: AudioPipeline,
    @Inject(MusicPresenter) private readonly presenter: MusicPresenter,
    @Inject(VoiceConnectionPort) private readonly voice: VoiceConnectionPort,
    private readonly events: EventEmitter2,
  ) {}

  private state(guildId: string): GuildMusicState {
    let s = this.guilds.get(guildId);
    if (!s) this.guilds.set(guildId, (s = new GuildMusicState()));
    return s;
  }

  /** Contexto "now playing" para el LLM. */
  getNowPlaying(guildId: string): string | null {
    const s = this.guilds.get(guildId);
    if (!s?.currentSong) return null;
    if (s.currentAlbum && s.currentAlbum !== 'Unknown Album') {
      return `${s.currentSong} | Álbum: ${s.currentAlbum}`;
    }
    return s.currentSong;
  }

  /** true si NINGÚN guild está reproduciendo o extrayendo stream. Lo consume
   *  YtdlUpdaterService para decidir si el sidecar puede reiniciarse. */
  isIdle(): boolean {
    for (const s of this.guilds.values()) {
      if (s.isBusy() || s.isFetching) return false;
    }
    return true;
  }

  private voiceChannelOf(member: GuildMember): VoiceChannelRef | null {
    return (member.voice?.channel as VoiceChannelRef | null) ?? null;
  }

  /** Conexión perdida irrecuperable (lo notifica el adapter): kill ffmpeg + descartar
   *  player — la conexión nueva necesita suscripción fresca o queda AutoPaused. */
  private onVoiceLost(guildId: string, why: string): void {
    const s = this.guilds.get(guildId);
    if (!s) return;
    this.pipeline.killCurrent(s);
    if (s.player) { try { s.player.stop(); } catch {} s.player = null; }
    this.logger.warn(`VC ${guildId}: ${why}.`);
  }

  async joinVoice(interaction: ChatInputCommandInteraction): Promise<boolean> {
    const vc = this.voiceChannelOf(interaction.member as GuildMember);
    if (!vc) {
      await safeFollowup(interaction, '¡Necesitas estar en un canal de voz para que pueda poner música!');
      return false;
    }
    const connection = await this.voice.ensureConnection(
      interaction.guildId, vc, (why) => this.onVoiceLost(interaction.guildId, why),
    );
    if (!connection) {
      await safeFollowup(interaction, 'No logré conectarme al canal de voz. Revisa los logs de MusicService (debug de voz activo).');
      return false;
    }
    return true;
  }

  async playNext(guildId: string, channel: ChannelHandle): Promise<void> {
    const s = this.state(guildId);
    if (s.isFetching) return;
    if (s.isBusy()) return;

    // Epoch: resetEpoch lo incrementa (/stop o reset por VC vacío). Verificar tras
    // cada await: una sesión cancelada no debe crear ffmpeg/player.
    const epoch = s.epoch;
    s.isFetching = true;
    s.textChannel = channel;
    let errored = false;
    try {
      s.clearVotes();

      if (s.isRadioMode) {
        if (s.queue.length === 0) {
          await this.autoQueueRadio(guildId, channel);
          if (s.epoch !== epoch) return;
        } else if (s.queue.length <= 2) {
          void this.autoQueueRadio(guildId, channel);
        }
      }

      if (s.queue.length > 0) {
        const item = s.popNext();
        if (!item) return;

        const fetchAbort = new AbortController();
        s.fetchAbort = fetchAbort;
        const { streamUrl, title } = await this.source.resolve(item, fetchAbort.signal);
        if (s.epoch !== epoch) return; // /stop durante el extract
        if (!streamUrl) throw new Error('No se pudo crear el recurso de audio.');
        s.startTrack(guildId, item, title);

        const player = this.ensurePlayer(guildId);
        const played = await this.pipeline.createAndPlay(s, streamUrl, player);
        if (s.epoch !== epoch) return; // /stop durante el pre-buffer
        if (!played) throw new Error('No se pudo crear el recurso de audio.');

        await this.presenter.nowPlaying(
          channel, s.currentSong ?? '', item.type === 'navidrome' ? item.cover_url : null,
        );
        this.publishDomainEvents(s);
      } else {
        s.markIdle();
      }
    } catch (e) {
      errored = true;
      this.logger.error(`Error reproduciendo música: ${(e as Error).message}`);
      await this.presenter.playbackError(channel, (e as Error).message);
    } finally {
      // Sólo la sesión dueña del epoch toca el flag: si un /stop la canceló,
      // resetEpoch ya lo dejó en false — pisarlo abriría una reentrada.
      if (s.epoch === epoch) s.isFetching = false;
    }
    // Recurrir sólo si la sesión no fue abortada: con epoch distinto, la cola que
    // importaba ya se vació con el reset.
    if (errored && s.epoch === epoch) void this.playNext(guildId, channel);
  }

  private ensurePlayer(guildId: string): PlayerHandle {
    const s = this.state(guildId);
    if (!s.player) {
      s.player = this.voice.createPlayer(guildId, () => this.onPlayerIdle(guildId));
    }
    return s.player;
  }

  private onPlayerIdle(guildId: string): void {
    const st = this.state(guildId);
    this.pipeline.killCurrent(st);
    st.isFetching = false;
    st.trackEnded(guildId);
    this.publishDomainEvents(st);
    if (st.textChannel) void this.playNext(guildId, st.textChannel);
  }

  private publishDomainEvents(s: GuildMusicState): void {
    for (const e of s.pullDomainEvents()) this.events.emit(e.event, e);
  }

  private async autoQueueRadio(guildId: string, channel: ChannelHandle): Promise<void> {
    const s = this.state(guildId);
    const navidromeIds = s.playHistory
      .filter((i) => i.type === 'navidrome' && i.id)
      .map((i) => i.id as string);
    let songs = await this.catalog.getSimilarSongs(navidromeIds, 10);
    if (!songs.length) songs = await this.catalog.getRandomSongs(10);
    if (!songs.length) return;

    let added = s.enqueueRadio(songs.map((song) => this.songToItem(song)));
    if (added === 0) {
      s.resetRadioPool();
      added = s.enqueueRadio((await this.catalog.getRandomSongs(10)).map((song) => this.songToItem(song)));
    }
    if (added > 0) await this.presenter.radioAdded(channel, added);
  }

  startRadioMode(guildId: string): void {
    this.state(guildId).startRadio();
  }

  songToItem(song: SongVo): QueueItemVo {
    return QueueItemVo.from({
      type: 'navidrome',
      url: this.catalog.getStreamUrl(song.id),
      id: song.id,
      title: song.title ?? undefined,
      artist: song.artist ?? undefined,
      album: song.album ?? undefined,
      cover_url: this.catalog.getCoverUrl(song.coverArt ?? undefined),
    })!;
  }

  async play(interaction: ChatInputCommandInteraction, url: string): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    if (!this.voice.isConnected(interaction.guildId)) {
      if (!(await this.joinVoice(interaction))) return;
    }
    const s = this.state(interaction.guildId);
    s.stopRadio();
    const item = QueueItemVo.from({ type: 'youtube', url });
    if (item) s.enqueue(item);

    const channel = this.textChannel(interaction);
    if (!channel) return;
    if (!s.isBusy() && !s.isFetching) {
      void this.playNext(interaction.guildId, channel);
      await safeFollowup(interaction, '▶️ Iniciando reproducción...');
    } else {
      await safeFollowup(interaction, `✅ Añadido a la cola: <${url}>`);
    }
  }

  async skip(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    const s = this.state(interaction.guildId);
    const player = s.player;
    if (!player || player.state.status === 'idle') {
      await safeFollowup(interaction, 'No hay nada reproduciéndose.', true);
      return;
    }
    const member = interaction.member as GuildMember;
    const myChannel = this.voice.activeChannelId(interaction.guildId);
    if (!member.voice?.channelId || member.voice.channelId !== myChannel) {
      await safeFollowup(interaction, 'Debes estar en el mismo canal de voz para saltar.', true);
      return;
    }
    const humans = await this.voice.humansInVoice(interaction.guildId, myChannel);
    const needed = Math.floor(humans.length / 2) + 1;
    const result = s.registerVote(interaction.user.id, needed);
    if (result === 'passed') {
      player.stop();
      s.clearVotes();
      await safeFollowup(interaction, '⏭️ ¡Votación completada! Saltando canción.');
    } else if (result === 'duplicate') {
      await safeFollowup(interaction, '¡Ya has votado para saltar!', true);
    } else {
      await safeFollowup(interaction, `🗳️ Voto registrado (${s.skipVotes.size}/${needed}).`);
    }
  }

  async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    this.resetPlaybackState(interaction.guildId);
    // POST /reset al sidecar: mata yt-dlp wedged; compose reinicia el contenedor en ~2s
    // y el extract reintenta ante ECONNREFUSED.
    this.source.reset();
    if (!this.voice.isConnected(interaction.guildId)) {
      await safeFollowup(interaction, 'No estoy conectado.');
      return;
    }
    this.voice.destroyConnection(interaction.guildId, 'stop');
    await safeFollowup(interaction, '⏹️ Música detenida y desconectada.');
  }

  async joinFromButton(guild: Guild, member: GuildMember): Promise<boolean> {
    const vc = this.voiceChannelOf(member);
    if (!vc) return false;
    const connection = await this.voice.ensureConnection(guild.id, vc, (why) => this.onVoiceLost(guild.id, why));
    return connection !== null;
  }

  async enqueueAndPlay(guild: Guild, channel: TextChannel, items: QueueItemVo[]): Promise<void> {
    const s = this.state(guild.id);
    for (const it of items) s.enqueue(it);
    s.textChannel = channel;
    if (!s.isBusy() && !s.isFetching) void this.playNext(guild.id, channel);
  }

  async queueInfo(interaction: ChatInputCommandInteraction): Promise<void> {
    const s = this.state(interaction.guildId);
    const current = s.currentSong;
    if (!s.queue.length && !current) {
      await interaction.reply({ content: 'La cola está vacía.' }).catch(() => {});
      return;
    }
    const lines: string[] = [];
    if (current) lines.push(`▶️ **Reproduciendo ahora:** ${current}`);
    if (s.queue.length) {
      lines.push('**En cola:**');
      s.queue.slice(0, 10).forEach((item, i) => {
        const fallback = item.type === 'youtube' ? `<${item.url}>` : item.url;
        let t = item.title ?? fallback;
        if (item.artist && !['Unknown Artist', 'Unknown'].includes(item.artist)) t = `${item.artist} - ${t}`;
        lines.push(`\`${i + 1}.\` ${t}`);
      });
      if (s.queue.length > 10) lines.push(`\n*...y ${s.queue.length - 10} canciones más.*`);
    }
    const embed = new EmbedBuilder()
      .setTitle('🎶 Cola de Reproducción')
      .setDescription(lines.join('\n'))
      .setColor(0x3498db)
      .setFooter({ text: 'Hakkurei Music' });
    if (s.currentCoverUrl) embed.setThumbnail(s.currentCoverUrl);
    await interaction
      .reply({ embeds: [embed] })
      .catch(() => interaction.reply({ content: `🎶 **Cola de Reproducción**\n\n${lines.join('\n')}` }).catch(() => {}));
  }

  async checkEmptyVoiceChannels(client: unknown): Promise<void> {
    this.voice.setClient(client);
    for (const [guildId, s] of this.guilds) {
      if (!this.voice.isConnected(guildId)) {
        s.emptySince = null;
        continue;
      }
      const channelId = this.voice.activeChannelId(guildId);
      if (!channelId) continue;
      const humans = await this.voice.humansInVoice(guildId, channelId);
      if (humans.length === 0) {
        if (s.emptySince == null) s.emptySince = Date.now();
        else if (Date.now() - s.emptySince >= EMPTY_VC_GRACE_MS) {
          this.resetPlaybackState(guildId);
          s.emptySince = null;
          this.voice.destroyConnection(guildId, `inactividad en ${guildId}`);
          this.logger.log(`Desconectado de ${guildId} por inactividad.`);
        }
      } else {
        s.emptySince = null;
      }
    }
  }

  private textChannel(interaction: ChatInputCommandInteraction): TextChannel | null {
    const ch = interaction.channel;
    return ch && ch.type === ChannelType.GuildText ? (ch as TextChannel) : null;
  }

  /** Resetea TODO el estado de reproducción de un guild. CRÍTICO: descarta el
   *  AudioPlayer cacheado — si no, tras /stop queda en estado no-Idle → isBusy
   *  eterno → el próximo /play deja la cola estancada y /skip no avanza. El handler
   *  Idle del player viejo es inofensivo: textChannel=null → no invoca playNext.
   *  No toca la conexión (la destruye el caller vía destroyConnection). */
  private resetPlaybackState(guildId: string): void {
    const s = this.state(guildId);
    s.resetEpoch(); // invalida cualquier playNext en vuelo (fetch + prebuffer)
    this.pipeline.killCurrent(s);
    if (s.player) { try { s.player.stop(); } catch {} s.player = null; }
  }
}

async function safeFollowup(interaction: ChatInputCommandInteraction, content: string, ephemeral = false): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral });
    } else {
      await interaction.reply({ content, ephemeral });
    }
  } catch {
    /* interacción expirada */
  }
}
