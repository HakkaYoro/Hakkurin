// Puerto del "DM invisible" (discord_client.py:694-801). El bot puede incrustar
// [MD:<id>]mensaje[/MD] en su respuesta pública; se extrae, se quita del texto
// público y se envía por DM al usuario ~3s después. Nunca lanza (errores silenciosos).
import { Injectable, Logger } from '@nestjs/common';
import {
  Client,
  DiscordAPIError,
  type Message,
  type TextBasedChannel,
} from 'discord.js';

// Regex fieles al fuente (docs/03 §3). La variante de cierre admite [/MD], /MD] y EOF.
const MD_EXTRACT = /\[MD:(\d+)\](.*?)(?:\[\/MD\]|\/MD\]|\[\/MD|$)/gis;
const MD_STRIP = /\[MD:\d+\].*?(?:\[\/MD\]|\/MD\]|\[\/MD|$)/gis;

export interface PendingDm {
  targetUid: string;
  msg: string;
}

@Injectable()
export class StealthDmService {
  private readonly logger = new Logger(StealthDmService.name);

  /** Extrae todos los bloques [MD:id]msg de un texto (no muta el regex global). */
  extractDms(text: string): PendingDm[] {
    const out: PendingDm[] = [];
    MD_EXTRACT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_EXTRACT.exec(text)) !== null) {
      const targetUid = m[1];
      const msg = m[2].trim();
      if (targetUid && msg) out.push({ targetUid, msg });
    }
    return out;
  }

  /** Quita los bloques [MD] del texto público. */
  stripDms(text: string): string {
    return text.replace(MD_STRIP, '').trim();
  }

  /** Programa el envío de DMs 3s después (fire-and-forget). */
  scheduleDelayedDms(message: Message, dms: PendingDm[], client: Client): void {
    if (!dms.length) return;
    setTimeout(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      for (const d of dms) await this.sendStealthDm(message, d.targetUid, d.msg, client);
    }, 0);
  }

  /** Resuelve al usuario (miembro del guild o global) y le envía el DM. Nunca lanza. */
  async sendStealthDm(
    message: Message,
    targetUid: string,
    dmMsg: string,
    client: Client,
  ): Promise<void> {
    const id = targetUid.trim();
    if (!/^\d+$/.test(id)) return;
    try {
      let target: any = null;
      if (message.guild) {
        try {
          target = await message.guild.members.fetch(id);
        } catch {
          target = null;
        }
      }
      if (!target) target = await client.users.fetch(id);
      if (target) {
        await target.send(dmMsg);
        this.logger.log(`[MD OCULTO] Enviado a ${id}`);
      }
    } catch (e) {
      if (e instanceof DiscordAPIError && (e.code === 50007 || e.status === 403)) {
        this.logger.warn(`[MD OCULTO] 403 Forbidden enviando a ${id}: DMs cerrados.`);
      } else {
        this.logger.warn(`[MD OCULTO] Error enviando a ${id}: ${(e as Error).message}`);
      }
    }
  }
}

/** Tipo auxiliar re-exportado para who lo necesite. */
export type { TextBasedChannel };
