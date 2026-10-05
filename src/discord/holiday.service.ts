// Use-case de festividades (puerto de discord_client.py:918-991), extraído de
// DiscordService. El @Interval(60000) con su guard isReady queda en DiscordService,
// que entrega el envío como callback (send) para no acoplar el use-case al gateway.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Client } from 'discord.js';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { delay } from '../common/util';
import type { AiBrain } from '../ai/ai-brain.interface';
import { MemoryService } from '../memory/memory.service';

@Injectable()
export class HolidayService {
  private readonly logger = new Logger(HolidayService.name);

  constructor(
    private readonly memory: MemoryService,
    @Inject('AiBrain') private readonly brain: AiBrain,
  ) {}

  /** Festividades en reloj GMT-4 (discord_client.py:918-960). */
  async checkHolidays(
    client: Client,
    send: (channelId: string, text: string) => Promise<void>,
  ): Promise<void> {
    // Wall clock GMT-4: desplazar epoch -4h y leer campos UTC (paridad con datetime.now(tz(-4))).
    const now = new Date(Date.now() - 4 * 3600 * 1000);
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const year = String(now.getUTCFullYear());

    const HOLIDAY_FILE = 'data/holidays.json';
    let data: Record<string, boolean> = {};
    try {
      if (existsSync(HOLIDAY_FILE)) data = JSON.parse(await readFile(HOLIDAY_FILE, 'utf8'));
    } catch {
      data = {};
    }

    // (mes, día, hora, minuto, key, nombre)
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
        await mkdir(dirname(HOLIDAY_FILE), { recursive: true });
        await writeFile(HOLIDAY_FILE, JSON.stringify(data));
        this.logger.log(`¡Es ${name}! Iniciando celebración global...`);
        await this.celebrateHoliday(client, name, send);
      } catch (e) {
        this.logger.warn(`Error celebrando ${name}: ${(e as Error).message}`);
      }
    }
  }

  /** Felicitación festiva (discord_client.py:962-991). */
  async celebrateHoliday(
    client: Client,
    holidayName: string,
    send: (channelId: string, text: string) => Promise<void>,
  ): Promise<void> {
    const users = await this.memory.getAllUsersData();
    this.logger.log(`Enviando felicitaciones de ${holidayName} a ${users.length} usuarios...`);
    for (const u of users) {
      if (!u.last_channel_id) continue;
      const channelId = String(u.last_channel_id);
      // Paridad discord_client.py:975-976: get_channel + if not channel: continue ANTES
      // de generar el greeting. Evita gastar LLM en usuarios con canal inaccesible.
      const channel = client.channels.cache.get(channelId) as any;
      if (!channel?.isTextBased?.()) continue;
      try {
        const msg = await this.brain.generateHolidayGreeting(u.summary ?? '', holidayName);
        await send(channelId, `<@${u.user_id}> ${msg}`);
        await delay(2000 + Math.random() * 3000); // evitar rate limit masivo
      } catch (e) {
        this.logger.warn(`Error felicitando a ${u.user_id}: ${(e as Error).message}`);
      }
    }
  }
}
