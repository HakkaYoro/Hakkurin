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
  models: Record<string, number>;
  users: Record<string, number>;
  commands: Record<string, number>;
  commandUsers: Record<string, Record<string, number>>;
}

export interface Totals {
  messages: number;
  aiCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  cost: number;
}

export interface RankingUser {
  id: string;
  messages: number;
}

export interface RankingCommand {
  command: string;
  count: number;
  topUserId: string | null;
  topUserCount: number;
}

export interface Rankings {
  windowDays: number;
  totals: Totals;
  prev: Totals;
  days: Array<DayStat & { day: string }>;
  heatmap: Array<{ day: string; messages: number }>;
  models: Array<{ model: string; calls: number }>;
  users: RankingUser[];
  commands: RankingCommand[];
}

const emptyDay = (): DayStat => ({
  messages: 0,
  aiCalls: {},
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  cost: 0,
  models: {},
  users: {},
  commands: {},
  commandUsers: {},
});

const emptyTotals = (): Totals => ({
  messages: 0,
  aiCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  cost: 0,
});

function dayKey(d = new Date()): string {
  return gmt4Date(d).toISOString().slice(0, 10);
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
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
      // Días guardados antes de users/commands/models quedan completos.
      this.days = new Map(Object.entries(raw).map(([k, d]) => [k, { ...emptyDay(), ...(d as DayStat) }]));
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

  bumpMessage(userId: string): void {
    const d = this.day();
    d.messages++;
    bump(d.users, userId);
  }

  bumpAiCall(kind: string): void {
    bump(this.day().aiCalls, kind);
  }

  bumpCommand(command: string, userId: string): void {
    const d = this.day();
    bump(d.commands, command);
    const perUser = d.commandUsers[command] ?? (d.commandUsers[command] = {});
    bump(perUser, userId);
  }

  addTokens(inTok: number, outTok: number, cached = 0, cost = 0, model = ''): void {
    const d = this.day();
    d.tokensIn += inTok;
    d.tokensOut += outTok;
    d.tokensCached += cached;
    d.cost = (d.cost ?? 0) + cost; // días viejos en stats.json no tienen cost
    if (model) bump(d.models, model);
  }

  rankings(days = 7): Rankings {
    const all = [...this.days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const window = all.slice(0, days);
    const prevWindow = all.slice(days, days * 2);

    const models: Record<string, number> = {};
    const users: Record<string, number> = {};
    const cmdCount: Record<string, number> = {};
    const cmdUsers: Record<string, Record<string, number>> = {};
    for (const [, d] of window) {
      for (const [m, n] of Object.entries(d.models)) models[m] = (models[m] ?? 0) + n;
      for (const [u, n] of Object.entries(d.users)) users[u] = (users[u] ?? 0) + n;
      for (const [c, n] of Object.entries(d.commands)) cmdCount[c] = (cmdCount[c] ?? 0) + n;
      for (const [c, perUser] of Object.entries(d.commandUsers)) {
        const acc = cmdUsers[c] ?? (cmdUsers[c] = {});
        for (const [u, n] of Object.entries(perUser)) acc[u] = (acc[u] ?? 0) + n;
      }
    }

    return {
      windowDays: days,
      totals: this.sumDays(window),
      prev: this.sumDays(prevWindow),
      days: window.map(([day, d]) => ({ day, ...d })).reverse(),
      heatmap: all.slice(0, 30).map(([day, d]) => ({ day, messages: d.messages })).reverse(),
      models: Object.entries(models)
        .map(([model, calls]) => ({ model, calls }))
        .sort((a, b) => b.calls - a.calls),
      users: Object.entries(users)
        .map(([id, messages]) => ({ id, messages }))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 10),
      commands: Object.entries(cmdCount)
        .map(([command, count]) => {
          let topUserId: string | null = null;
          let topUserCount = 0;
          const top = Object.entries(cmdUsers[command] ?? {}).sort((a, b) => b[1] - a[1])[0];
          if (top) {
            topUserId = top[0];
            topUserCount = top[1];
          }
          return { command, count, topUserId, topUserCount };
        })
        .sort((a, b) => b.count - a.count),
    };
  }

  private sumDays(entries: Array<[string, DayStat]>): Totals {
    const t = emptyTotals();
    for (const [, d] of entries) {
      t.messages += d.messages;
      t.tokensIn += d.tokensIn;
      t.tokensOut += d.tokensOut;
      t.tokensCached += d.tokensCached;
      t.cost += d.cost ?? 0;
      t.aiCalls += Object.values(d.aiCalls).reduce((a, b) => a + b, 0);
    }
    return t;
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
