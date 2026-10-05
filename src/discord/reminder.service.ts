// Use-case de recordatorios embebidos en la auto-memoria (puerto de
// discord_client.py:104-205), extraído de DiscordService. El @Interval(60000) y su
// guard de reentrada quedan en DiscordService (los errores suben a su catch); el
// cache de dedupe vive AQUÍ para conservar la dedupe entre llamadas de la instancia.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Client } from 'discord.js';
import type { AiBrain } from '../ai/ai-brain.interface';
import { BOT_SELF_ID, MemoryService } from '../memory/memory.service';
import { ActionParserService, type ScheduledAction } from '../scheduler/action-parser.service';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);
  // dedupe de recordatorios ejecutados (actionKey → epoch sec). TTL 1h. Puerto de discord_client.py:123-128.
  private readonly executedActionsCache = new Map<string, number>();

  constructor(
    private readonly memory: MemoryService,
    @Inject('AiBrain') private readonly brain: AiBrain,
    private readonly parser: ActionParserService,
  ) {}

  async checkReminders(client: Client, lastActiveChannelId: string | null): Promise<void> {
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

      // Resolver canal objetivo (memoria del target → último canal activo → cualquier usuario).
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

      // Paridad discord_client.py:159-161: el canal debe estar en caché (get_channel).
      // Si no lo está (borrado / DM no cacheado tras restart), se reintenta al minuto
      // SIN consumir el recordatorio. isTextBased descarta canales sin .send.
      const channel = client.channels.cache.get(channelId) as any;
      if (!channel?.isTextBased?.()) continue;

      let ctxId = BOT_SELF_ID;
      let userName = 'Sistema';
      let ping = '';
      if (targetUserId && /^\d+$/.test(targetUserId)) {
        ctxId = targetUserId;
        ping = `<@${targetUserId}> `;
        try {
          const u = await client.users.fetch(targetUserId);
          if (u) userName = u.username;
        } catch {
          userName = 'Usuario';
        }
      }

      const prompt =
        `[SISTEMA]: EJECUCIÓN DE RECORDATORIO AUTOMÁTICO.\n` +
        `ACCIÓN: ${actionDesc}\n` +
        `INSTRUCCIÓN: Genera el mensaje para cumplir este compromiso ahora mismo.\n` +
        `NOTA: Debes mencionar al usuario ${ping.trim()} si corresponde. Usa tu memoria con él para ser personal y natural.`;
      let response = await this.brain.generateResponse(prompt, ctxId, userName);
      if (typeof response !== 'string' || !response.trim()) {
        response = `${ping}recordatorio: ${actionDesc}`.trim();
      }

      // Paridad :191-193: marcar ejecutado SÓLO si el envío real tuvo éxito. Si
      // send lanza, la acción no se cachea ni se borra → reintenta. (sendMessageCallback
      // traga errores, así que aquí enviamos directo y vigilamos el resultado.)
      let sent = false;
      try {
        await channel.send(response);
        sent = true;
      } catch (e) {
        this.logger.warn(`Error enviando recordatorio a ${channelId}: ${(e as Error).message}`);
      }
      if (!sent) continue;

      this.executedActionsCache.set(key, nowSec);
      executed.push(action);
      await this.memory.logSelfAction(`EJECUTÉ RECORDATORIO: ${actionDesc} para ${userName}`);
    }

    if (executed.length) {
      const cleaned = this.parser.removeExecutedActionsFromMemory(selfMemoryText, executed);
      if (cleaned !== selfMemoryText) {
        await this.memory.updateSummary(BOT_SELF_ID, cleaned, []);
      }
    }
  }
}
