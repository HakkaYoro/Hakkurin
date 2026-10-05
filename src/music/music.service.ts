// Casos de uso de música (puerto de bot/music_manager.py). Estado por guild +
// reproducción con @discordjs/voice. El evento AudioPlayerStatus.Idle REEMPLAZA
// al callback after= y al guard is_fetching (music_manager.py:167-173,236).
// Arquitectura hexagonal mínima: los puertos (StreamSource, AudioPipeline,
// MusicPresenter) viven en music.ports.ts, el dominio en music.domain.ts y los
// adaptadores concretos en sidecar.client.ts / ffmpeg.adapter.ts /
// music.presenter.ts. La lógica de voz (connect, joinVC, attachVoiceDiagnostics,
// ensurePlayer, tearDownConnection) se queda aquí: es la orquestación del
// use-case. ponytail: extraer un VoiceGateway sería una interface con un solo
// consumidor; upgrade path: si un segundo consumidor de voz aparece (p.ej. grabación),
// mover connect/joinVC/attachVoiceDiagnostics detrás de un puerto.
import { Injectable, Logger } from '@nestjs/common';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { ConfigService } from '../common/config.service';
import { NavidromeService, type NavidromeSong } from '../navidrome/navidrome.service';
import { delay } from '../common/util';
import {
  isBusy,
  newState,
  type GuildMusicState,
  type PlayerHandle,
  type QueueItem,
} from './music.domain';
import type { AudioPipeline, MusicPresenter, StreamSource } from './music.ports';
import { SidecarClient } from './sidecar.client';
import { FfmpegAdapter } from './ffmpeg.adapter';
import { DiscordPresenter } from './music.presenter';

export type { QueueItem } from './music.domain';

const EMPTY_VC_GRACE_MS = 5 * 60 * 1000; // 5 min → desconectar
// Pre-buffer (anti-stutter): pausa tras spawn ffmpeg para que llene el PassThrough
// antes de sonar. CPU modesto (i5-2400) + canal de voz 64k → 5s de colchón.
const PREBUFFER_MS = 5_000;

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);
  private readonly guilds = new Map<string, GuildMusicState>();
  private readonly source: StreamSource;
  private readonly pipeline: AudioPipeline;
  private readonly presenter: MusicPresenter;

  constructor(
    private readonly config: ConfigService,
    private readonly navidrome: NavidromeService,
  ) {
    // ponytail: adaptadores concretos inline — una implementación por puerto, sin
    // fábrica ni DI especulativa. Upgrade path: inyectarlos por constructor si
    // aparece una segunda implementación.
    this.source = new SidecarClient(config);
    this.pipeline = new FfmpegAdapter();
    this.presenter = new DiscordPresenter();
  }

  private state(guildId: string): GuildMusicState {
    let s = this.guilds.get(guildId);
    if (!s) this.guilds.set(guildId, (s = newState()));
    return s;
  }

  /** Contexto "now playing" para el LLM (discord_client.py:484-491). */
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
      if (isBusy(s) || s.isFetching) return false;
    }
    return true;
  }

  // --- Conexión de voz ---
  private voiceChannelOf(member: GuildMember) {
    return (member.voice?.channel as { id: string; guild: { voiceAdapterCreator: any } } | null) ?? null;
  }

  // Log de transiciones de estado y reconexión automática. El canal 'debug'
  // (habilitado vía joinVoiceChannel({debug:true})) revela el close-code del WS
  // de voz y el READY (ip/modes). Idempotente (__hakDiag): joinFromButton puede
  // llamarse sobre la MISMA conexión persistente en cada clic de botón.
  private attachVoiceDiagnostics(connection: VoiceConnection, guildId: string): void {
    if ((connection as any).__hakDiag) return;
    (connection as any).__hakDiag = true;
    connection.on('stateChange', (oldState, newState) => {
      this.logger.debug(`VC ${guildId}: ${oldState.status} → ${newState.status}`);
      if (newState.status !== VoiceConnectionStatus.Disconnected) return;
      const reason = (newState as any).reason as VoiceConnectionDisconnectReason | undefined;
      // EndpointRemoved / Manual nunca se recuperan solos: cortar de inmediato.
      if (reason === VoiceConnectionDisconnectReason.EndpointRemoved ||
          reason === VoiceConnectionDisconnectReason.Manual) {
        this.tearDownConnection(guildId, connection, 'desconexión irrecuperable');
        return;
      }
      // Recoverable: la librería re-emite OP4 (→ Signalling) o re-configura la red
      // (→ Connecting). Race de ambos, luego re-confirmar Ready antes de dar por buena.
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ])
        .then(() => entersState(connection, VoiceConnectionStatus.Ready, 30_000))
        .then(() => this.logger.log(`VC ${guildId}: reconectado.`))
        .catch(() => this.tearDownConnection(guildId, connection, 'reconexión falló'));
    });
    connection.on('error', (e) => this.logger.warn(`VC networking ${guildId}: ${e.message}`));
  }

  /** Destruye la conexión + mata ffmpeg + limpia state. Centraliza el teardown. */
  private tearDownConnection(guildId: string, connection: VoiceConnection, why: string): void {
    const s = this.guilds.get(guildId);
    if (s) this.pipeline.killCurrent(s);
    try { connection.destroy(); } catch {}
    if (s) s.connection = null;
    this.logger.warn(`VC ${guildId}: ${why}.`);
  }

  // Join de un solo intento. El force-IPv4 vive en main.ts (porteo del source_address
  // '0.0.0.0' del Python legacy), así que no hay nada que reintentar a nivel de join;
  // reintentar la misma conexión no resuelve otras causas (close-code, sesión stale).
  private async joinVC(
    guildId: string,
    create: () => VoiceConnection,
  ): Promise<VoiceConnection | null> {
    const connection = create();
    this.attachVoiceDiagnostics(connection, guildId);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      return connection;
    } catch (e) {
      this.logger.error(`No se pudo conectar al VC ${guildId}: ${(e as Error).message}`);
      this.tearDownConnection(guildId, connection, 'join falló');
      return null;
    }
  }

  /**
   * Join compartido por joinVoice y joinFromButton. Centraliza: cleanup de
   * ghost-session (anti 4006), el joinVC idempotente, y la pausa de
   * estabilización anti-"audio a 2×". Devuelve la conexión lista o null.
   */
  private async connect(
    guildId: string,
    guild: Guild,
    vc: { id: string; guild: { voiceAdapterCreator: any } },
  ): Promise<VoiceConnection | null> {
    // joinVoiceChannel es idempotente: si la conexión ya existe la reconfigura
    // con datos frescos del Gateway. Una Destroyed no se recicla (crea una nueva).
    const existing = getVoiceConnection(guildId);

    // Prevención de 4006 (Session no longer valid): un restart deja una ghost
    // session que recicla session_id viejo + token nuevo → el Voice WS devuelve
    // 4006. Desconectar primero fuerza un session_id nuevo.
    const me = guild.members?.me;
    if (!existing && me?.voice?.channelId) {
      this.logger.debug(`Limpiando ghost session del VC ${me.voice.channelId}...`);
      try { await me.voice.disconnect(); } catch {}
      await delay(1000);
    }

    const connection = await this.joinVC(guildId, () =>
      joinVoiceChannel({
        channelId: vc.id,
        guildId,
        adapterCreator: vc.guild.voiceAdapterCreator,
        selfDeaf: true,
        debug: true,
      }),
    );
    if (!connection) return null;
    // Estabiliza el socket UDP de voz (previene audio "a 2×": discord_client.py:152-153).
    if (!existing) await delay(1000);
    return connection;
  }

  async joinVoice(interaction: ChatInputCommandInteraction): Promise<boolean> {
    const vc = this.voiceChannelOf(interaction.member as GuildMember);
    if (!vc) {
      await safeFollowup(interaction, '¡Necesitas estar en un canal de voz para que pueda poner música!');
      return false;
    }
    const connection = await this.connect(interaction.guildId, interaction.guild!, vc);
    if (!connection) {
      await safeFollowup(interaction, 'No logré conectarme al canal de voz. Revisa los logs de MusicService (debug de voz activo).');
      return false;
    }
    this.state(interaction.guildId).connection = connection;
    return true;
  }

  // --- Reproducción (music_manager.py:164-258) ---
  async playNext(guild: Guild, channel: TextChannel): Promise<void> {
    const s = this.state(guild.id);
    // TEMP(diagnóstico avance): si Idle dispara pero playNext aborta, estos logs lo revelan.
    if (s.isFetching) { this.logger.debug('playNext abort: isFetching'); return; }
    if (isBusy(s)) { this.logger.debug('playNext abort: isBusy'); return; }

    s.isFetching = true;
    s.textChannel = channel;
    let errored = false;
    try {
      s.skipVotes.clear();

      // Radio infinita: recargar si vacía, prefetch si queda poco.
      if (s.isRadioMode) {
        if (s.queue.length === 0) {
          await this.autoQueueRadio(guild.id, channel);
        } else if (s.queue.length <= 2) {
          void this.autoQueueRadio(guild.id, channel);
        }
      }

      if (s.queue.length > 0) {
        const item = s.queue.shift()!;
        s.playHistory.push(item);
        if (s.playHistory.length > 5) s.playHistory.shift();

        const { streamUrl } = await this.source.resolve(item);
        const resource = this.pipeline.create(s, streamUrl);
        if (!resource) throw new Error('No se pudo crear el recurso de audio.');

        if (item.type === 'navidrome') {
          const title = item.title ?? 'Navidrome Stream';
          const artist = item.artist ?? 'Unknown Artist';
          s.currentArtist = artist;
          s.currentAlbum = item.album ?? 'Unknown Album';
          s.currentSong = artist !== 'Unknown Artist' ? `${artist} - ${title}` : title;
          s.currentCoverUrl = item.cover_url ?? null;
        } else {
          s.currentSong = item.title ?? 'YouTube';
          s.currentCoverUrl = null;
        }

        const player = this.ensurePlayer(guild.id);
        // Pre-buffer: esperar PREBUFFER_MS tras spawn para que ffmpeg llene el
        // PassThrough (1MB) y el player arranque con colchón. Sin esto el jitter de
        // fuente/red llega a underrun → stutter (CPU modesto i5-2400).
        await delay(PREBUFFER_MS);
        player.play(resource);

        // Embed sólo para Navidrome con cover; el resto, texto plano.
        const cover = item.type === 'navidrome' ? (item.cover_url ?? null) : null;
        await this.presenter.nowPlaying(channel, s.currentSong, cover);
      } else {
        s.currentSong = null;
        s.currentCoverUrl = null;
      }
    } catch (e) {
      errored = true;
      this.logger.error(`Error reproduciendo música: ${(e as Error).message}`);
      await this.presenter.playbackError(channel, (e as Error).message);
    } finally {
      s.isFetching = false;
    }
    // Avanzar sólo tras resetear isFetching: evita que el finally pise el flag de
    // la recursión y abra una reentrada.
    if (errored) void this.playNext(guild, channel);
  }

  private ensurePlayer(guildId: string): PlayerHandle {
    const s = this.state(guildId);
    if (!s.player) {
      const player = createAudioPlayer();
      // Idle = canción terminó → matar ffmpeg y avanzar cola (reemplaza after=).
      player.on(AudioPlayerStatus.Idle, () => {
        // TEMP(diagnóstico avance): confirma que Idle dispara al terminar/skippear.
        // Borrar tras verificar el Fix 1 en vivo.
        this.logger.debug(`player Idle → playNext (guild ${guildId})`);
        const st = this.state(guildId);
        this.pipeline.killCurrent(st);
        st.isFetching = false;
        if (st.textChannel) {
          // textChannel se guardó como ChannelHandle (dominio puro); aquí es el
          // TextChannel real que playNext asignó.
          void this.playNext(st.textChannel.guild, st.textChannel as TextChannel);
        }
      });
      player.on('error', (e) => this.logger.error(`AudioPlayer error: ${e.message}`));
      s.player = player;
    }
    // Re-bind siempre. subscribe() es idempotente (dedupea por conexión); la
    // conexión destruida ya limpió su suscripción. Sin esto, tras /stop→/play o
    // una reconexión el player cacheado queda sin suscripción → AutoPaused → silencio.
    if (s.connection) s.connection.subscribe(s.player);
    return s.player;
  }

  // --- Radio infinita (music_manager.py:260-313) ---
  private async autoQueueRadio(guildId: string, channel: TextChannel): Promise<void> {
    const s = this.state(guildId);
    const navidromeIds = s.playHistory
      .filter((i) => i.type === 'navidrome' && i.id)
      .map((i) => i.id!) as string[];
    let songs = await this.navidrome.getSimilarSongs(navidromeIds, 10);
    if (!songs.length) songs = await this.navidrome.getRandomSongs(10);
    if (!songs.length) return;

    let added = 0;
    for (const song of songs) {
      if (s.radioPlayedIds.has(song.id)) continue;
      s.radioPlayedIds.add(song.id);
      s.queue.push(this.songToItem(song));
      added++;
    }
    // Todo ya reproducido → resetear y rellenar con random.
    if (added === 0) {
      s.radioPlayedIds.clear();
      const randoms = await this.navidrome.getRandomSongs(10);
      for (const song of randoms) {
        s.radioPlayedIds.add(song.id);
        s.queue.push(this.songToItem(song));
        added++;
      }
    }
    if (added > 0) await this.presenter.radioAdded(channel, added);
  }

  /** Activa modo radio para un guild (navidrome_ui.py:57-58,69-70,82-83). */
  startRadioMode(guildId: string): void {
    const s = this.state(guildId);
    s.isRadioMode = true;
    s.radioPlayedIds.clear();
  }

  songToItem(song: NavidromeSong): QueueItem {
    return {
      type: 'navidrome',
      url: this.navidrome.getStreamUrl(song.id),
      id: song.id,
      title: song.title ?? 'Unknown',
      artist: song.artist ?? 'Unknown',
      album: song.album ?? 'Unknown Album',
      cover_url: this.navidrome.getCoverUrl(song.coverArt),
    };
  }

  // --- Comandos públicos (music_manager.py:315-447) ---
  async play(interaction: ChatInputCommandInteraction, url: string): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    if (!getVoiceConnection(interaction.guildId)) {
      if (!(await this.joinVoice(interaction))) return;
    }
    const s = this.state(interaction.guildId);
    s.isRadioMode = false;
    s.radioPlayedIds.clear();
    s.queue.push({ type: 'youtube', url });

    const guild = interaction.guild!;
    const channel = this.textChannel(interaction);
    if (!guild || !channel) return;
    if (!isBusy(s) && !s.isFetching) {
      void this.playNext(guild, channel);
      await safeFollowup(interaction, '▶️ Iniciando reproducción...');
    } else {
      await safeFollowup(interaction, `✅ Añadido a la cola: <${url}>`);
    }
  }

  async playNavidromeItems(interaction: ChatInputCommandInteraction, songs: QueueItem[]): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    if (!getVoiceConnection(interaction.guildId)) {
      if (!(await this.joinVoice(interaction))) return;
    }
    const s = this.state(interaction.guildId);
    for (const song of songs) s.queue.push(song);

    const guild = interaction.guild!;
    const channel = this.textChannel(interaction);
    if (!guild || !channel) return;
    if (!isBusy(s) && !s.isFetching) {
      void this.playNext(guild, channel);
      await safeFollowup(interaction, '▶️ Iniciando reproducción de Navidrome...');
    } else {
      const c = songs.length > 1 ? `${songs.length} canciones` : '1 canción';
      await safeFollowup(interaction, `✅ ${c} añadida(s) a la cola desde Navidrome.`);
    }
  }

  async skip(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    const s = this.state(interaction.guildId);
    const player = s.player;
    // Idle = nada cargado; Buffering/Playing/Paused = algo suena (skip permitido).
    if (!player || player.state.status === AudioPlayerStatus.Idle) {
      await safeFollowup(interaction, 'No hay nada reproduciéndose.', true);
      return;
    }
    const member = interaction.member as GuildMember;
    // Canal en vivo del bot (no joinConfig, que es stale si arrastran al bot).
    const myChannel = (interaction.guild as any)?.members?.me?.voice?.channelId;
    if (!member.voice?.channelId || member.voice.channelId !== myChannel) {
      await safeFollowup(interaction, 'Debes estar en el mismo canal de voz para saltar.', true);
      return;
    }
    // Votación de mayoría: mitad + 1 de los humanos en el canal (comportamiento
    // deseado). Alcanzada la mayoría, player.stop() fuerza Idle → playNext avanza.
    const humans = await this.humansInVoice(interaction.guild!, myChannel);
    const needed = Math.floor(humans.length / 2) + 1;
    if (!s.skipVotes.has(interaction.user.id)) {
      s.skipVotes.add(interaction.user.id);
      const votes = s.skipVotes.size;
      if (votes >= needed) {
        player.stop();
        s.skipVotes.clear();
        await safeFollowup(interaction, '⏭️ ¡Votación completada! Saltando canción.');
      } else {
        await safeFollowup(interaction, `🗳️ Voto registrado (${votes}/${needed}).`);
      }
    } else {
      await safeFollowup(interaction, '¡Ya has votado para saltar!', true);
    }
  }

  async stop(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.deferred) await interaction.deferReply().catch(() => {});
    // Limpieza al 100%: cola, metadata de la canción actual, ffmpeg Y el player
    // (descartado → el próximo /play crea uno limpio en vez de reutilizar uno
    // colgado que dejaría la cola estancada).
    this.resetPlaybackState(interaction.guildId);
    const conn = getVoiceConnection(interaction.guildId);
    if (!conn) {
      await safeFollowup(interaction, 'No estoy conectado.');
      return;
    }
    this.tearDownConnection(interaction.guildId, conn, 'stop');
    await safeFollowup(interaction, '⏹️ Música detenida y desconectada.');
  }

  // Variantes para interacciones de botón (no ChatInputCommandInteraction): unen
  // por guild/member y encolan por canal directo (navidrome_ui.py callbacks).
  async joinFromButton(guild: Guild, member: GuildMember): Promise<boolean> {
    const vc = this.voiceChannelOf(member);
    if (!vc) return false;
    const connection = await this.connect(guild.id, guild, vc);
    if (!connection) return false;
    this.state(guild.id).connection = connection;
    return true;
  }

  async enqueueAndPlay(guild: Guild, channel: TextChannel, items: QueueItem[]): Promise<void> {
    const s = this.state(guild.id);
    for (const it of items) s.queue.push(it);
    s.textChannel = channel;
    if (!isBusy(s) && !s.isFetching) void this.playNext(guild, channel);
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
        // YouTube sin título resuelto (se resuelve perezosamente tras el shift):
        // URL envuelta en <> = clic limpio, no rompe el layout como la URL cruda.
        const fallback = item.type === 'youtube' ? `<${item.url}>` : (item.url ?? 'Unknown');
        let t = item.title ?? fallback;
        if (item.artist && !['Unknown Artist', 'Unknown'].includes(item.artist)) t = `${item.artist} - ${t}`;
        lines.push(`\`${i + 1}.\` ${t}`);
      });
      if (s.queue.length > 10) lines.push(`\n*...y ${s.queue.length - 10} canciones más.*`);
    }
    // Mismo estilo que el embed de "now playing": título, color azul, footer y
    // thumbnail de la canción actual cuando es Navidrome (con cover).
    const embed = new EmbedBuilder()
      .setTitle('🎶 Cola de Reproducción')
      .setDescription(lines.join('\n'))
      .setColor(0x3498db) // blue
      .setFooter({ text: 'Hakkurei Music' });
    if (s.currentCoverUrl) embed.setThumbnail(s.currentCoverUrl);
    await interaction
      .reply({ embeds: [embed] })
      .catch(() => interaction.reply({ content: `🎶 **Cola de Reproducción**\n\n${lines.join('\n')}` }).catch(() => {}));
  }

  // --- Limpieza de VC vacío (music_manager.py:105-126) — Phase 6 la dispara. ---
  async checkEmptyVoiceChannels(client: any): Promise<void> {
    for (const [guildId, s] of this.guilds) {
      const conn = getVoiceConnection(guildId);
      if (!conn) {
        s.emptySince = null;
        continue;
      }
      // Canal en vivo del bot (no joinConfig, stale si lo arrastran a otro canal).
      const guild = client.guilds?.cache?.get(guildId);
      const channelId = (guild as any)?.members?.me?.voice?.channelId ?? (conn as any)?.joinConfig?.channelId;
      if (!channelId) continue;
      const channel = client.channels.cache.get(channelId);
      const humans = channel?.members ? [...channel.members.values()].filter((m: any) => !m.user?.bot && !m.bot) : [];
      if (humans.length === 0) {
        if (s.emptySince == null) s.emptySince = Date.now();
        else if (Date.now() - s.emptySince >= EMPTY_VC_GRACE_MS) {
          this.resetPlaybackState(guildId);
          s.emptySince = null;
          this.tearDownConnection(guildId, conn, `inactividad en ${guildId}`);
          this.logger.log(`Desconectado de ${guildId} por inactividad.`);
        }
      } else {
        s.emptySince = null;
      }
    }
  }

  // --- Helpers ---
  private textChannel(interaction: ChatInputCommandInteraction): TextChannel | null {
    const ch = interaction.channel;
    return ch && ch.type === ChannelType.GuildText ? (ch as TextChannel) : null;
  }

  /** Resetea TODO el estado de reproducción de un guild: cola, votos, flags de
   *  radio, metadata de la canción actual, isFetching, ffmpeg y —CRÍTICO— descarta
   *  el AudioPlayer cacheado. Si no se descarta, tras /stop queda colgado en estado
   *  no-Idle → isBusy eterno → el próximo /play deja la cola estancada y /skip no
   *  avanza (bug: "vuelve con la última canción en silencio"). El handler Idle del
   *  player viejo es inofensivo: textChannel=null → no invoca playNext. No toca la
   *  conexión (la destruye el caller vía tearDownConnection). */
  private resetPlaybackState(guildId: string): void {
    const s = this.state(guildId);
    s.queue = [];
    s.skipVotes.clear();
    s.isRadioMode = false;
    s.radioPlayedIds.clear();
    s.currentSong = null;
    s.currentCoverUrl = null;
    s.currentAlbum = 'Unknown Album';
    s.currentArtist = 'Unknown Artist';
    s.isFetching = false;
    s.textChannel = null;
    this.pipeline.killCurrent(s);
    if (s.player) { try { s.player.stop(); } catch {} s.player = null; }
  }

  private async humansInVoice(guild: Guild, channelId: string): Promise<GuildMember[]> {
    const ch = guild.channels.cache.get(channelId);
    if (!ch || !('members' in ch)) return [];
    const members = (ch as any).members as Map<string, GuildMember>;
    return [...members.values()].filter((m) => !m.user?.bot);
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
