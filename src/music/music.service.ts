// Puerto de bot/music_manager.py. Estado por guild + reproducción con
// @discordjs/voice. El evento AudioPlayerStatus.Idle REEMPLAZA al callback after=
// y al guard is_fetching (music_manager.py:167-173,236). ffmpeg emite Opus 48k
// estéreo directo (StreamType.OggOpus, sin re-encode JS); el volumen se aplica vía
// filtro de ffmpeg. Un PassThrough de read-ahead (BUFFER_BYTES) amortigua el jitter
// de fuente/red para evitar stutter (el buffer del OggDemuxer interno es ~320ms).
// YouTube se resuelve vía sidecar yt-dlp (sidecar/extract_server.py); Navidrome
// trae URL de stream directa.
import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import {
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  type AudioPlayer,
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

const SIDECAR_DEFAULT = 'http://localhost:7654';
const EMPTY_VC_GRACE_MS = 5 * 60 * 1000; // 5 min → desconectar
const VOLUME = 0.5;
// Buffer de read-ahead entre ffmpeg y el OggDemuxer. Sin coste de latencia (sólo
// gobierna backpressure al writer); aguanta ~1-2min de Opus ante un stall de fuente.
const BUFFER_BYTES = 1024 * 1024;

export interface QueueItem {
  type: 'youtube' | 'navidrome';
  url: string;
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  cover_url?: string | null;
}

interface GuildMusicState {
  queue: QueueItem[];
  currentSong: string | null;
  currentArtist: string;
  currentAlbum: string;
  skipVotes: Set<string>;
  emptySince: number | null;
  playHistory: QueueItem[];
  isRadioMode: boolean;
  radioPlayedIds: Set<string>;
  isFetching: boolean;
  player: AudioPlayer | null;
  connection: VoiceConnection | null;
  textChannel: TextChannel | null;
  ffmpeg: ChildProcess | null; // proceso ffmpeg del track actual; SIGKILL al cambiar/cortar
}

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);
  private readonly guilds = new Map<string, GuildMusicState>();

  constructor(
    private readonly config: ConfigService,
    private readonly navidrome: NavidromeService,
  ) {}

  /**
   * Ocupado = hay player Y su estado no es Idle. Tras player.play() el player pasa
   * por Buffering antes de Playing; tratar cualquier estado no-Idle como ocupado
   * evita doble play / canción cortada (equivalente al is_playing() de discord.py,
   * que es true desde el instante de play()). isFetching cubre la ventana del await.
   */
  private isBusy(s: GuildMusicState): boolean {
    return !!s.player && s.player.state.status !== AudioPlayerStatus.Idle;
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
    if (s?.ffmpeg) { try { s.ffmpeg.kill('SIGKILL'); } catch {} s.ffmpeg = null; }
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
    if (this.isBusy(s)) { this.logger.debug('playNext abort: isBusy'); return; }

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

        const streamUrl = await this.resolveStreamUrl(item);
        const resource = this.makeResource(guild.id, streamUrl);
        if (!resource) throw new Error('No se pudo crear el recurso de audio.');

        if (item.type === 'navidrome') {
          const title = item.title ?? 'Navidrome Stream';
          const artist = item.artist ?? 'Unknown Artist';
          s.currentArtist = artist;
          s.currentAlbum = item.album ?? 'Unknown Album';
          s.currentSong = artist !== 'Unknown Artist' ? `${artist} - ${title}` : title;
        } else {
          s.currentSong = item.title ?? 'YouTube';
        }

        const player = this.ensurePlayer(guild.id);
        player.play(resource);

        if (item.type === 'navidrome' && item.cover_url) {
          await this.sendNowPlayingEmbed(channel, s.currentSong, item.cover_url);
        } else {
          await sendText(channel, `🎶 Reproduciendo ahora: **${s.currentSong}**`);
        }
      } else {
        s.currentSong = null;
      }
    } catch (e) {
      errored = true;
      this.logger.error(`Error reproduciendo música: ${(e as Error).message}`);
      await sendText(channel, `Ocurrió un error al reproducir: ${(e as Error).message}`);
    } finally {
      s.isFetching = false;
    }
    // Avanzar sólo tras resetear isFetching: evita que el finally pise el flag de
    // la recursión y abra una reentrada.
    if (errored) void this.playNext(guild, channel);
  }

  private ensurePlayer(guildId: string): AudioPlayer {
    const s = this.state(guildId);
    if (!s.player) {
      const player = createAudioPlayer();
      // Idle = canción terminó → matar ffmpeg y avanzar cola (reemplaza after=).
      player.on(AudioPlayerStatus.Idle, () => {
        // TEMP(diagnóstico avance): confirma que Idle dispara al terminar/skippear.
        // Borrar tras verificar el Fix 1 en vivo.
        this.logger.debug(`player Idle → playNext (guild ${guildId})`);
        const st = this.state(guildId);
        if (st.ffmpeg) { try { st.ffmpeg.kill('SIGKILL'); } catch {} st.ffmpeg = null; }
        st.isFetching = false;
        if (st.textChannel) void this.playNext(st.textChannel.guild, st.textChannel);
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

  private makeResource(guildId: string, streamUrl: string): AudioResource | null {
    if (!streamUrl) return null;
    const s = this.state(guildId);
    // Cortar cualquier ffmpeg previo (skip/stop/reemplazo de track).
    if (s.ffmpeg) { try { s.ffmpeg.kill('SIGKILL'); } catch {} s.ffmpeg = null; }

    // ffmpeg → Opus estéreo 48k directo (sin re-encode JS/opusscript). Volumen vía
    // filtro de ffmpeg. Salida por pipe a un PassThrough con read-ahead grande.
    const ff = spawn('ffmpeg', [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      // read-ahead del thread de input: sin esto puede starvarse periódicamente y
      // producir gaps que el PassThrough (que vive después de ffmpeg) no puede tapar.
      '-thread_queue_size', '512',
      '-i', streamUrl,
      '-f', 'opus', '-ar', '48000', '-ac', '2',
      '-filter:a', `volume=${VOLUME}`,
      '-loglevel', 'error', '-hide_banner', 'pipe:1',
    ]);
    s.ffmpeg = ff;
    // Drenar stderr: debug + evita que el pipe kernel (64KB) se llene en bucles de
    // error y atasque stdout (→ underrun → stutter).
    ff.stderr.on('data', (d: Buffer) => this.logger.debug(`ffmpeg: ${d.toString().trim()}`));
    ff.on('error', (e) => this.logger.error(`ffmpeg spawn falló: ${e.message}. ¿ffmpeg instalado?`));
    ff.once('exit', () => { if (s.ffmpeg === ff) s.ffmpeg = null; });

    // Buffer de read-ahead: amortigua jitter de fuente/red (sin coste de latencia:
    // highWaterMark sólo gobierna el backpressure al writer).
    const buf = new PassThrough({ highWaterMark: BUFFER_BYTES });
    ff.stdout.pipe(buf);
    ff.stdout.on('error', () => {}); // tragar EPIPE tras kill
    buf.on('error', () => {});

    // Forzar EOF del buffer al cerrar ffmpeg. Sin esto el PassThrough puede no
    // propagar el fin → el AudioResource nunca termina → el player no pasa a Idle
    // → la cola no avanza (bug de avance + radio). 'close' se emite siempre
    // (natural o tras SIGKILL) y tras el cierre de los stdio, así que buf ya recibió
    // todo el Opus. Idempotente si el pipe ya había terminado. Si esto no dispara
    // Idle en vivo, subir a buf.destroy().
    ff.once('close', () => { try { buf.end(); } catch {} });

    return createAudioResource(buf, { inputType: StreamType.OggOpus, inlineVolume: false });
  }

  private async resolveStreamUrl(item: QueueItem): Promise<string> {
    if (item.type === 'navidrome') return item.url;
    // YouTube → sidecar yt-dlp extrae la URL directa de stream.
    const sidecar = this.config.get<string>('ytdl_sidecar_url', SIDECAR_DEFAULT);
    const url = `${sidecar}/extract?url=${encodeURIComponent(item.url)}`;

    let res: Response;
    try {
      // ponytail: AbortSignal.timeout (stdlib) — bounda la llamada; un sidecar
      // colgado no bloquea playNext indefinidamente.
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e: any) {
      // "fetch failed" esconde la razón en e.cause (ECONNREFUSED/ENOTFOUND/TimeoutError…).
      const c = e?.cause;
      const reason = c?.code ?? c?.syscall ?? c?.hostname ?? e?.name ?? e?.message;
      this.logger.warn(`Sidecar yt-dlp falló para ${item.url}: ${reason}`);
      return '';
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 502 = yt-dlp desactualizado/bot-blocked; 404 = sin resultados; 500 = URL no resuelta.
      this.logger.warn(`Sidecar ${res.status} para ${item.url}: ${body.slice(0, 200)}`);
      return '';
    }

    const data: any = await res.json().catch(() => null);
    if (!data?.stream_url) {
      this.logger.warn(`Sidecar 200 sin stream_url para ${item.url}`);
      return '';
    }
    if (!item.title && data.title) item.title = data.title;
    return data.stream_url;
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
    if (added > 0) await sendText(channel, `📻 *Radio: Añadidas ${added} canciones en la cola.*`);
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
    if (!this.isBusy(s) && !s.isFetching) {
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
    if (!this.isBusy(s) && !s.isFetching) {
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
    const s = this.state(interaction.guildId);
    s.isRadioMode = false;
    s.radioPlayedIds.clear();
    s.queue = [];
    s.skipVotes.clear();
    const conn = getVoiceConnection(interaction.guildId);
    if (!conn) {
      await safeFollowup(interaction, 'No estoy conectado.');
      return;
    }
    s.player?.stop();
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
    if (!this.isBusy(s) && !s.isFetching) void this.playNext(guild, channel);
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
    await interaction.reply({ content: `🎶 **Cola de Reproducción**\n\n${lines.join('\n')}` }).catch(() => {});
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
          s.queue = [];
          s.skipVotes.clear();
          s.emptySince = null;
          s.player?.stop();
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

  private async humansInVoice(guild: Guild, channelId: string): Promise<GuildMember[]> {
    const ch = guild.channels.cache.get(channelId);
    if (!ch || !('members' in ch)) return [];
    const members = (ch as any).members as Map<string, GuildMember>;
    return [...members.values()].filter((m) => !m.user?.bot);
  }

  private async sendNowPlayingEmbed(channel: TextChannel, title: string, coverUrl: string): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🎶 Reproduciendo ahora')
      .setDescription(`**${title}**`)
      .setColor(0x3498db) // blue
      .setThumbnail(coverUrl)
      .setFooter({ text: 'Hakkurei Music' });

    try {
      await channel.send({ embeds: [embed] });
    } catch {
      await sendText(channel, `🎶 Reproduciendo ahora: **${title}**`);
    }
  }
}

function newState(): GuildMusicState {
  return {
    queue: [],
    currentSong: null,
    currentArtist: 'Unknown Artist',
    currentAlbum: 'Unknown Album',
    skipVotes: new Set(),
    emptySince: null,
    playHistory: [],
    isRadioMode: false,
    radioPlayedIds: new Set(),
    isFetching: false,
    player: null,
    connection: null,
    textChannel: null,
    ffmpeg: null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function sendText(channel: TextChannel | null, content: string): Promise<void> {
  if (!channel) return;
  try {
    await (channel as any).send(content);
  } catch {
    /* canal no disponible */
  }
}
