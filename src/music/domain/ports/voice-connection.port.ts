import type { ConnectionHandle, PlayerHandle } from '../music.domain';

export interface VoiceChannelRef {
  id: string;
  guild: {
    voiceAdapterCreator: unknown;
    // Capturado lazy por el adapter (skip/humansInVoice antes del primer loop del DiscordAdapter).
    client?: unknown;
    members?: { me?: { voice?: { channelId?: string | null; disconnect?: () => Promise<unknown> } } };
  };
}

export abstract class VoiceConnectionPort {
  /** Conecta al VC (o reutiliza la viva): cleanup de ghost session 4006, espera
   *  de Ready y estabilización del UDP incluidas. onLost lo invoca el adapter
   *  cuando la conexión se pierde irrecuperablemente (limpieza de app: kill
   *  ffmpeg + descartar player). null si no pudo conectar. */
  abstract ensureConnection(
    guildId: string,
    vc: VoiceChannelRef,
    onLost?: (why: string) => void,
  ): Promise<ConnectionHandle | null>;

  abstract createPlayer(guildId: string, onIdle: () => void): PlayerHandle;

  abstract isConnected(guildId: string): boolean;

  abstract activeChannelId(guildId: string): string | null;

  /** Destruye la conexión (el kill de ffmpeg lo hace AudioPipeline.killCurrent). */
  abstract destroyConnection(guildId: string, why: string): void;

  abstract humansInVoice(guildId: string, channelId: string): Promise<{ id: string }[]>;

  /** Inyección lazy del Client: lo pasa DiscordAdapter en su loop de VC vacíos. */
  abstract setClient(client: unknown): void;
}
