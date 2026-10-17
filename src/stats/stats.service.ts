import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import { atomicWrite, gmt4Date } from '../common/util';

const STATS_FILE = 'data/stats.json';
const KEEP_DAYS = 30;

export interface DayStat {
  messages: number;
  aiCalls: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  cost: number; // créditos OpenRouter (usage.cost); 0 en proveedores sin coste
}

const emptyDay = (): DayStat => ({
  messages: 0,
  aiCalls: {},
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  cost: 0,
});

function dayKey(d = new Date()): string {
  return gmt4Date(d).toISOString().slice(0, 10);
}

@Injectable()
export class StatsService implements OnModuleDestroy {
  private readonly logger = new Logger(StatsService.name);
  private days = new Map<string, DayStat>();
  private loadPromise: Promise<void> | null = null;

  constructor() {
    this.loadPromise = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(STATS_FILE, 'utf-8'));
      this.days = new Map(Object.entries(raw));
    } catch {
      // sin stats aún: empezar de cero
    }
  }

  private day(): DayStat {
    const key = dayKey();
    let d = this.days.get(key);
    if (!d) {
      d = emptyDay();
      this.days.set(key, d);
    }
    return d;
  }

  bumpMessages(): void {
    this.day().messages++;
  }

  bumpAiCall(kind: string): void {
    const d = this.day();
    d.aiCalls[kind] = (d.aiCalls[kind] ?? 0) + 1;
  }

  addTokens(inTok: number, outTok: number, cached = 0, cost = 0): void {
    const d = this.day();
    d.tokensIn += inTok;
    d.tokensOut += outTok;
    d.tokensCached += cached;
    d.cost = (d.cost ?? 0) + cost; // días viejos en stats.json no tienen cost
  }

  snapshot(count = 7): Array<DayStat & { day: string }> {
    return [...this.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, count)
      .map(([day, d]) => ({ day, ...d }));
  }

  @Interval(60000)
  private async flush(): Promise<void> {
    await this.loadPromise;
    const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const key of this.days.keys()) {
      if (key < cutoff) this.days.delete(key);
    }
    try {
      await atomicWrite(STATS_FILE, JSON.stringify(Object.fromEntries(this.days)));
    } catch (e) {
      this.logger.warn(`No pude guardar stats: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
