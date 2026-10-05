import { forwardRef, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { nowSec } from '../../common/util';
import { SleepStorePort } from '../domain/ports/json-store.port';
import { MessageTransportPort } from '../domain/ports/message-transport.port';

const SLEEP_DURATION_S = 2 * 60 * 60;

@Injectable()
export class SleepService implements OnModuleInit {
  private readonly logger = new Logger(SleepService.name);
  private isSleeping = false;
  private sleepUntil = 0;
  private tired: string[] = ['Me voy a dormir.'];
  private recovery: string[] = ['Ya volví.'];

  constructor(
    private readonly store: SleepStorePort,
    @Inject(forwardRef(() => MessageTransportPort))
    private readonly transport: MessageTransportPort,
  ) {}

  async onModuleInit(): Promise<void> {
    const raw = await this.store.loadStatusMessages();
    if (raw.tired?.length) this.tired = raw.tired;
    if (raw.recovery?.length) this.recovery = raw.recovery;
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

  async enterSleep(channelId: string): Promise<void> {
    this.isSleeping = true;
    this.sleepUntil = nowSec() + SLEEP_DURATION_S;
    await this.transport.sendToChannel(channelId, this.randomTired(), { typing: true });
    this.logger.log(`Modo Sueño activado hasta ${this.sleepUntil}`);
  }

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
