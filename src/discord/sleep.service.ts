// Puerto del modo sueño (discord_client.py:826-869). Estado + frases, sin cliente.
// DiscordService/Phase6 pasan el callback de envío y el test de API.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { nowSec } from '../common/util';

const SLEEP_DURATION_S = 2 * 60 * 60; // 2h
const STATUS_FILE = 'data/status_messages.json';

@Injectable()
export class SleepService implements OnModuleInit {
  private readonly logger = new Logger(SleepService.name);
  private isSleeping = false;
  private sleepUntil = 0; // epoch seconds
  private tired: string[] = ['Me voy a dormir.'];
  private recovery: string[] = ['Ya volví.'];

  async onModuleInit(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(STATUS_FILE, 'utf-8')) as Record<string, string[]>;
      if (raw.tired?.length) this.tired = raw.tired;
      if (raw.recovery?.length) this.recovery = raw.recovery;
    } catch {
      this.logger.warn(`No pude leer ${STATUS_FILE}, usando frases por defecto.`);
    }
  }

  get sleeping(): boolean {
    return this.isSleeping;
  }

  get wakeTime(): number {
    return this.sleepUntil;
  }

  randomTired(): string {
    return this.tired[Math.floor(Math.random() * this.tired.length)];
  }

  randomRecovery(): string {
    return this.recovery[Math.floor(Math.random() * this.recovery.length)];
  }

  /** Activa el sueño por 2h y envía frase de cansancio vía send(). */
  async enterSleep(send: (msg: string) => Promise<void>): Promise<void> {
    this.isSleeping = true;
    this.sleepUntil = nowSec() + SLEEP_DURATION_S;
    try {
      await send(this.randomTired());
    } catch {
      /* canal puede no existir; silencioso */
    }
    this.logger.log(`Modo Sueño activado hasta ${this.sleepUntil}`);
  }

  /**
   * Sonda de recuperación (recovery_check_task :841-869). Si pasó el tiempo,
   * prueba la API: sana → despierta (devuelve recovered=true); sigue mal → +2h.
   * El llamador envía la frase de recuperación si recovered.
   */
  async recoveryProbe(
    testApi: () => Promise<boolean>,
  ): Promise<{ checked: boolean; recovered: boolean }> {
    if (!this.isSleeping) return { checked: false, recovered: false };
    if (nowSec() <= this.sleepUntil) return { checked: false, recovered: false };

    const healthy = await testApi();
    if (healthy) {
      this.isSleeping = false;
      this.sleepUntil = 0;
      this.logger.log('API recuperada. Despertando.');
      return { checked: true, recovered: true };
    }
    this.sleepUntil = nowSec() + SLEEP_DURATION_S;
    this.logger.warn('API sigue fallando. Durmiendo 2h más.');
    return { checked: true, recovered: false };
  }
}
