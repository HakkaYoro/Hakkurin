export interface ReplyReference {
  messageId: string;
  channelId: string;
}

export interface SendOptions {
  /** Typing previo + pausa humanizada (1-3s) antes del envío. */
  typing?: boolean;
  /** Cita el mensaje indicado; reintenta sin cita si el referenciado fue borrado. */
  replyTo?: ReplyReference;
}

/**
 * Los envíos NUNCA lanzan: devuelven false/null ante canal inaccesible o
 * error de API (el adapter loguea).
 */
export abstract class MessageTransportPort {
  /** Resolución local desde caché, sin red. */
  abstract isChannelSendable(channelId: string): boolean;
  abstract sendTyping(channelId: string): Promise<void>;
  abstract sendToChannel(channelId: string, content: string, opts?: SendOptions): Promise<boolean>;
  /** DM directo: miembro del guild indicado si hay, si no usuario global. */
  abstract sendDm(userId: string, content: string, guildId?: string | null): Promise<boolean>;
  /** Descarga binaria para contexto multimodal; null si falla. */
  abstract fetchImage(url: string): Promise<Buffer | null>;
  /** Username global de Discord (para prompts); null si no resoluble. */
  abstract fetchUsername(userId: string): Promise<string | null>;
  /** Log de salida en DMs, sólo con debug_dm activo. */
  abstract logDmOutput(channelId: string, userName: string, userId: string, msgText: string): void;
  abstract getBotUserId(): string | null;
}
