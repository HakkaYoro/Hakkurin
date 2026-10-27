// El @Interval vive en DiscordAdapter: dedupe en memoria de esta instancia entre iteraciones del loop.
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { PROMPT_REMINDER, fill } from '../../ai/application/ai-prompts';
import { ConfigService } from '../../common/config.service';
import { BOT_SELF_ID, MemoryService } from '../../memory/application/memory.service';
import { ActionParserService, type ScheduledAction } from './action-parser.service';
import { MessageTransportPort } from '../domain/ports/message-transport.port';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  private readonly executedActionsCache = new Map<string, number>();

  constructor(
    private readonly memory: MemoryService,
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly parser: ActionParserService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => MessageTransportPort))
    private readonly transport: MessageTransportPort,
  ) {}

  async checkReminders(lastActiveChannelId: string | null): Promise<void> {
    const selfMemoryText = await this.memory.getSelfMemory();
    if (!selfMemoryText) return;

    const actions = this.parser.parseScheduledActions(selfMemoryText);
    const due = this.parser.checkDueActions(actions);
    if (!due.length) return;

    const nowSec = Date.now() / 1000;
    for (const [k, ts] of this.executedActionsCache) {
      if (nowSec - ts > 3600) this.executedActionsCache.delete(k);
    }

    const executed: ScheduledAction[] = [];
    for (const action of due) {
      const key = this.parser.buildActionKey(action);
      if (this.executedActionsCache.has(key)) continue;

      const actionDesc = action.action_description;
      const targetUserId = action.target_user_id;

      let channelId: string | null = null;
      if (targetUserId && /^\d+$/.test(targetUserId)) {
        const targetMem = await this.memory.getMemory(targetUserId);
        if (targetMem.last_channel_id != null) channelId = String(targetMem.last_channel_id);
      }
      if (!channelId) channelId = lastActiveChannelId;
      if (!channelId) {
        for (const u of await this.memory.getAllUsersData()) {
          if (u.last_channel_id) {
            channelId = String(u.last_channel_id);
            break;
          }
        }
      }
      if (!channelId) continue;

      // Canal no en caché (borrado / DM no cacheado tras restart): reintenta al
      // minuto SIN consumir el recordatorio.
      if (!this.transport.isChannelSendable(channelId)) continue;

      let ctxId = BOT_SELF_ID;
      let userName = 'Sistema';
      let ping = '';
      if (targetUserId && /^\d+$/.test(targetUserId)) {
        ctxId = targetUserId;
        ping = `<@${targetUserId}> `;
        userName = (await this.transport.fetchUsername(targetUserId)) ?? 'Usuario';
      }

      const prompt = fill(this.config.get('prompt_reminder') || PROMPT_REMINDER, {
        accion: actionDesc,
        ping: ping.trim() || 'nadie',
        nombre: userName,
      });
      let response = await this.brain.generateResponse(prompt, ctxId, userName);
      if (typeof response !== 'string' || !response.trim()) {
        response = `${ping}recordatorio: ${actionDesc}`.trim();
      }

      // Marcar ejecutado SÓLO si el envío tuvo éxito: sendToChannel devuelve false
      // si la API rechaza → la acción no se cachea ni se borra → reintenta.
      const sent = await this.transport.sendToChannel(channelId, response);
      if (!sent) continue;

      this.executedActionsCache.set(key, nowSec);
      executed.push(action);
      // Evento de sistema, no un turno: va sin la pareja [ELLOS DIJERON] y con el
      // marcador exacto que el FILTRO CRITICO del prompt del self busca.
      await this.memory.addInteraction(
        BOT_SELF_ID,
        `[SISTEMA] EJECUTÉ RECORDATORIO: ${actionDesc} para ${userName}`,
      );
    }

    if (executed.length) {
      const cleaned = this.parser.removeExecutedActionsFromMemory(selfMemoryText, executed);
      if (cleaned !== selfMemoryText) {
        await this.memory.updateSummary(BOT_SELF_ID, cleaned, []);
      }
    }
  }
}
