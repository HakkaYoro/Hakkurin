// Puerto de core/conversation_manager.py. Sesiones por (channel,user) + contexto
// global por canal (historial, imágenes recientes, actividad del bot). check_timeouts
// se invoca desde el scheduler (Phase 6); aquí vive la lógica.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiBrain } from '../ai/ai-brain.interface';
import { MemoryService } from '../memory/memory.service';
import { nowSec } from '../common/util';

const SESSION_TIMEOUT_S = 5 * 60; // 5 min
const HISTORY_WINDOW_S = 3600; // 1h
const HISTORY_MAX = 50;
const IMAGE_WINDOW_S = 300; // 5 min

interface StoredMessage {
  ts: number;
  content: string;
  author: string;
  authorId: string;
}
interface StoredImage {
  ts: number;
  data: Buffer;
  mime: string;
}

class Session {
  lastInteraction: number;
  isActive = false;
  ignoredCount = 0;
  private context: { ts: number; content: string }[] = [];

  constructor(
    public readonly channelId: string,
    public readonly userId: string,
  ) {
    this.lastInteraction = nowSec();
  }

  updateInteraction(): void {
    this.lastInteraction = nowSec();
  }

  activate(): void {
    this.isActive = true;
    this.lastInteraction = nowSec();
  }
}

class ChannelContext {
  messages: StoredMessage[] = [];
  recentImages: StoredImage[] = [];
  lastBotActivity = 0;

  addMessage(authorName: string, authorId: string, content: string): void {
    const now = nowSec();
    this.messages.push({ ts: now, content, author: authorName, authorId });
    this.cleanup(now);
  }

  addImage(data: Buffer, mime: string): void {
    const now = nowSec();
    this.recentImages.push({ ts: now, data, mime });
    this.cleanup(now);
  }

  getRecentImages(seconds = 60): { data: Buffer; mime: string }[] {
    const cutoff = nowSec() - seconds;
    return this.recentImages.filter((i) => i.ts > cutoff).map((i) => ({ data: i.data, mime: i.mime }));
  }

  updateBotActivity(): void {
    this.lastBotActivity = nowSec();
  }

  isBotEngaged(timeout = 60): boolean {
    return nowSec() - this.lastBotActivity < timeout;
  }

  getFormattedHistory(): string[] {
    return this.messages.map((m) => `${m.author} (ID: ${m.authorId}): ${m.content}`);
  }

  private cleanup(now: number): void {
    const cutoff = now - HISTORY_WINDOW_S;
    this.messages = this.messages.filter((m) => m.ts > cutoff).slice(-HISTORY_MAX);
    const imgCutoff = now - IMAGE_WINDOW_S;
    this.recentImages = this.recentImages.filter((i) => i.ts > imgCutoff);
  }
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly channels = new Map<string, ChannelContext>();

  constructor(
    @Inject('AiBrain') private readonly brain: AiBrain,
    private readonly memory: MemoryService,
  ) {}

  private key(channelId: string, userId: string): string {
    return `${channelId}:${userId}`;
  }

  getChannelContext(channelId: string): ChannelContext {
    let ctx = this.channels.get(channelId);
    if (!ctx) {
      ctx = new ChannelContext();
      this.channels.set(channelId, ctx);
    }
    return ctx;
  }

  createOrUpdateSession(
    channelId: string,
    userId: string,
    userName?: string | null,
    messageContent?: string | null,
  ): Session {
    const k = this.key(channelId, userId);
    let session = this.sessions.get(k);
    if (!session) {
      session = new Session(channelId, userId);
      this.sessions.set(k, session);
      this.logger.debug(`Nueva sesión para ${userId} en ${channelId}`);
    } else {
      session.updateInteraction();
    }
    if (userName && messageContent) {
      this.getChannelContext(channelId).addMessage(userName, userId, messageContent);
    }
    return session;
  }

  /** IDs de usuarios activos en el canal en los últimos X minutos. */
  getActiveUsers(channelId: string, minutes = 20): string[] {
    const ctx = this.getChannelContext(channelId);
    const cutoff = nowSec() - minutes * 60;
    const ids = new Set<string>();
    for (const m of ctx.messages) if (m.ts > cutoff) ids.add(m.authorId);
    return [...ids];
  }

  endSession(channelId: string, userId: string): void {
    this.sessions.delete(this.key(channelId, userId));
  }

  /**
   * Revisa sesiones activas expiradas (>5min). 12.5% de probabilidad de generar
   * una despedida/queja vía IA (máx 2 mensajes); el resto timeout silencioso.
   * sendCallback: (channelId, text) => Promise<void>.
   */
  /** ¿Hay alguna sesión activa? (estado online/idle del loop de timeouts). */
  hasActiveSession(): boolean {
    for (const s of this.sessions.values()) if (s.isActive) return true;
    return false;
  }

  async checkTimeouts(
    sendCallback: (channelId: string, text: string) => Promise<void>,
  ): Promise<void> {
    const now = nowSec();
    const expired: string[] = [];
    for (const [k, session] of this.sessions) {
      if (!session.isActive) continue;
      if (now - session.lastInteraction <= SESSION_TIMEOUT_S) continue;

      if (Math.random() > 0.125) {
        this.logger.debug(`Timeout silencioso (7/8) para ${k}`);
      } else {
        const channelHistory = this.getChannelContext(session.channelId).getFormattedHistory();
        const fakeMsg =
          '[SISTEMA]: El usuario ha dejado de responder por 5 minutos. ¿Quieres decir algo antes de irte? ' +
          '(Si no, responde con intent: ignore) (Máximo 2 mensajes cortos)';
        try {
          const analysis = await this.brain.analyzeInteraction({
            userText: fakeMsg,
            userId: session.userId,
            userName: 'System',
            contextMessages: channelHistory,
            isSessionActive: true,
            isDm: false,
          });
          if (['complain', 'reply', 'new_topic'].includes(analysis.intent)) {
            const content = Array.isArray(analysis.response_content)
              ? analysis.response_content
              : [analysis.response_content];
            for (let i = 0; i < Math.min(2, content.length); i++) {
              if (typeof content[i] === 'string') await sendCallback(session.channelId, content[i]);
            }
          }
        } catch (e) {
          this.logger.warn(`Error en timeout check: ${(e as Error).message}`);
        }
      }
      expired.push(k);
    }
    for (const k of expired) {
      const [channelId, userId] = k.split(':');
      this.endSession(channelId, userId);
    }
  }
}
