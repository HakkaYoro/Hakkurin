import { Injectable, Logger } from '@nestjs/common';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { delay } from '../../../common/util';
import type { ConnectionHandle, PlayerHandle } from '../../domain/music.domain';
import { VoiceConnectionPort, type VoiceChannelRef } from '../../domain/ports/voice-connection.port';

@Injectable()
export class VoiceAdapter extends VoiceConnectionPort {
  private readonly logger = new Logger(VoiceAdapter.name);
  private client: any = null;

  setClient(client: unknown): void {
    this.client = client;
  }

  isConnected(guildId: string): boolean {
    return getVoiceConnection(guildId) !== null;
  }

  activeChannelId(guildId: string): string | null {
    const me = (this.client?.guilds?.cache?.get(guildId) as any)?.members?.me;
    const conn = getVoiceConnection(guildId) as any;
    return me?.voice?.channelId ?? conn?.joinConfig?.channelId ?? null;
  }

  async ensureConnection(
    guildId: string,
    vc: VoiceChannelRef,
    onLost?: (why: string) => void,
  ): Promise<ConnectionHandle | null> {
    // Captura lazy del Client: skip votes funcionan antes del primer loop del DiscordAdapter.
    if (vc.guild?.client) this.client = vc.guild.client;
    const existing = getVoiceConnection(guildId);

    // Prevención de 4006 (Session no longer valid): un restart deja una ghost
    // session que recicla session_id viejo + token nuevo → el Voice WS devuelve
    // 4006. Desconectar primero fuerza un session_id nuevo.
    const me = vc.guild?.members?.me;
    if (!existing && me?.voice?.channelId) {
      this.logger.debug(`Limpiando ghost session del VC ${me.voice.channelId}...`);
      try { await me.voice.disconnect?.(); } catch {}
      await delay(1000);
    }

    const connection = await this.joinVC(guildId, vc, onLost);
    if (!connection) return null;
    // Estabiliza el socket UDP de voz: sin pausa el audio suena a 2×.
    if (!existing) await delay(1000);
    return connection;
  }

  createPlayer(guildId: string, onIdle: () => void): PlayerHandle {
    const player = createAudioPlayer();
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', (e: Error) => this.logger.error(`AudioPlayer error: ${e.message}`));
    const conn = getVoiceConnection(guildId);
    if (conn) conn.subscribe(player);
    return player;
  }

  destroyConnection(guildId: string, why: string): void {
    const conn = getVoiceConnection(guildId);
    if (!conn) return;
    try { conn.destroy(); } catch {}
    this.logger.warn(`VC ${guildId}: ${why}.`);
  }

  async humansInVoice(guildId: string, channelId: string): Promise<{ id: string }[]> {
    const ch = this.client?.channels?.cache?.get(channelId) as any;
    if (!ch?.members) return [];
    return [...ch.members.values()]
      .filter((m: any) => !m.user?.bot && !m.bot)
      .map((m: any) => ({ id: m.id as string }));
  }

  private async joinVC(guildId: string, vc: VoiceChannelRef, onLost?: (why: string) => void): Promise<ConnectionHandle | null> {
    const connection = joinVoiceChannel({
      channelId: vc.id,
      guildId,
      adapterCreator: vc.guild.voiceAdapterCreator as any,
      selfDeaf: true,
      debug: true,
    });
    this.attachDiagnostics(guildId, connection, onLost);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      return connection;
    } catch (e) {
      this.logger.error(`No se pudo conectar al VC ${guildId}: ${(e as Error).message}`);
      this.detach(guildId, connection, 'join falló', onLost);
      return null;
    }
  }

  // debug:true revela el close-code del WS de voz y el READY (ip/modes): sin ese
  // canal, un desconecto de voz es indiagnóstico. Idempotente (__hakDiag): el join
  // puede re-llegar sobre la misma conexión persistente (clics de botón).
  private attachDiagnostics(guildId: string, connection: any, onLost?: (why: string) => void): void {
    if (connection.__hakDiag) return;
    connection.__hakDiag = true;
    connection.on('stateChange', (oldState: any, newState: any) => {
      this.logger.debug(`VC ${guildId}: ${oldState.status} → ${newState.status}`);
      if (newState.status !== VoiceConnectionStatus.Disconnected) return;
      const reason = newState.reason as VoiceConnectionDisconnectReason | undefined;
      if (reason === VoiceConnectionDisconnectReason.EndpointRemoved ||
          reason === VoiceConnectionDisconnectReason.Manual) {
        this.detach(guildId, connection, 'desconexión irrecuperable', onLost);
        return;
      }
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ])
        .then(() => entersState(connection, VoiceConnectionStatus.Ready, 30_000))
        .then(() => this.logger.log(`VC ${guildId}: reconectado.`))
        .catch(() => this.detach(guildId, connection, 'reconexión falló', onLost));
    });
    connection.on('error', (e: Error) => this.logger.warn(`VC networking ${guildId}: ${e.message}`));
  }

  /** onLost = limpieza de app (kill ffmpeg + descartar player, ver MusicService). */
  private detach(guildId: string, connection: ConnectionHandle, why: string, onLost?: (why: string) => void): void {
    onLost?.(why);
    try { connection.destroy(); } catch {}
    this.logger.warn(`VC ${guildId}: ${why}.`);
  }
}
