import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { MessageTransportPort } from '../domain/ports/message-transport.port';

const MD_EXTRACT = /\[MD:(\d+)\](.*?)(?:\[\/MD\]|\/MD\]|\[\/MD|$)/gis;
const MD_STRIP = /\[MD:\d+\].*?(?:\[\/MD\]|\/MD\]|\[\/MD|$)/gis;

export interface PendingDm {
  targetUid: string;
  msg: string;
}

@Injectable()
export class StealthDmService {
  private readonly logger = new Logger(StealthDmService.name);

  constructor(
    @Inject(forwardRef(() => MessageTransportPort))
    private readonly transport: MessageTransportPort,
  ) {}

  /** Extrae los bloques [MD:id]msg (lastIndex=0: el regex /g global conserva estado). */
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

  stripDms(text: string): string {
    return text.replace(MD_STRIP, '').trim();
  }

  /** Envía los DMs 3s después de la respuesta pública (fire-and-forget). */
  scheduleDelayedDms(guildId: string | null, dms: PendingDm[]): void {
    if (!dms.length) return;
    setTimeout(async () => {
      await new Promise((r) => setTimeout(r, 3000));
      for (const d of dms) await this.sendStealthDm(d.targetUid, d.msg, guildId);
    }, 0);
  }

  /** Nunca lanza; sólo loguea el éxito. */
  async sendStealthDm(targetUid: string, dmMsg: string, guildId?: string | null): Promise<void> {
    const id = targetUid.trim();
    if (!/^\d+$/.test(id)) return;
    if (await this.transport.sendDm(id, dmMsg, guildId)) {
      this.logger.log(`[MD OCULTO] Enviado a ${id}`);
    }
  }
}
