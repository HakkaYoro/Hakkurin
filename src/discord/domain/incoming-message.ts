export interface IncomingAttachment {
  name: string;
  url: string;
  contentType: string | null;
}

/** DTO sin tipos de discord.js; DiscordAdapter lo construye desde el Message real. */
export interface IncomingMessage {
  id: string;
  channelId: string;
  /** null = DM (sin guild). */
  guildId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  /** IDs de usuarios mencionados, excluyendo bots. */
  mentionIds: string[];
  attachments: IncomingAttachment[];
}
