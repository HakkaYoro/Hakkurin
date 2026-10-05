import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { MemoryService } from '../../memory/application/memory.service';
import { nowSec } from '../../common/util';
import { Session } from '../domain/entities/session.entity';
import { ChannelContext } from '../domain/entities/channel-context.entity';

const SESSION_TIMEOUT_S = 5 * 60;

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly sessions = new Map<string, Session>();
  private readonly channels = new Map<string, ChannelContext>();

  constructor(
    @Inject(AiBrain) private readonly brain: AiBrain,
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
