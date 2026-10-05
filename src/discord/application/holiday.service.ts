import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { delay } from '../../common/util';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { MemoryService } from '../../memory/application/memory.service';
import { HolidayStorePort } from '../domain/ports/json-store.port';
import { MessageTransportPort } from '../domain/ports/message-transport.port';

@Injectable()
export class HolidayService {
  private readonly logger = new Logger(HolidayService.name);

  constructor(
    private readonly memory: MemoryService,
    @Inject(AiBrain) private readonly brain: AiBrain,
    @Inject(forwardRef(() => MessageTransportPort))
    private readonly transport: MessageTransportPort,
    @Inject(HolidayStorePort) private readonly store: HolidayStorePort,
  ) {}

  async checkHolidays(): Promise<void> {
    // Wall clock GMT-4: desplazar epoch -4h y leer campos UTC.
    const now = new Date(Date.now() - 4 * 3600 * 1000);
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const year = String(now.getUTCFullYear());

    const data = await this.store.load();

    const events: ReadonlyArray<readonly [number, number, number, number, string, string]> = [
      [12, 25, 0, 1, 'xmas', 'Navidad'],
      [1, 1, 0, 0, 'newyear', 'Año Nuevo'],
    ];

    for (const [m, d, h, min, key, name] of events) {
      if (month !== m || day !== d || hour !== h || minute !== min) continue;
      const eventKey = `${key}_${year}`;
      if (data[eventKey]) continue;
      data[eventKey] = true;
      try {
        await this.store.save(data);
        this.logger.log(`¡Es ${name}! Iniciando celebración global...`);
        await this.celebrateHoliday(name);
      } catch (e) {
        this.logger.warn(`Error celebrando ${name}: ${(e as Error).message}`);
      }
    }
  }

  async celebrateHoliday(holidayName: string): Promise<void> {
    const users = await this.memory.getAllUsersData();
    this.logger.log(`Enviando felicitaciones de ${holidayName} a ${users.length} usuarios...`);
    for (const u of users) {
      if (!u.last_channel_id) continue;
      const channelId = String(u.last_channel_id);
      // Resolver el canal ANTES del greeting: no gastar LLM en canales inaccesibles.
      if (!this.transport.isChannelSendable(channelId)) continue;
      try {
        const msg = await this.brain.generateHolidayGreeting(u.summary ?? '', holidayName);
        await this.transport.sendToChannel(channelId, `<@${u.user_id}> ${msg}`, { typing: true });
        await delay(2000 + Math.random() * 3000); // evitar rate limit masivo
      } catch (e) {
        this.logger.warn(`Error felicitando a ${u.user_id}: ${(e as Error).message}`);
      }
    }
  }
}
