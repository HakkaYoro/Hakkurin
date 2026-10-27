import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import { atomicWrite, gmt4Date } from '../common/util';

const STATS_FILE = 'data/stats.json';
const KEEP_DAYS = 366;
// Los buckets horarios de hace más de 7 días se compactan a buckets de día
// (clave 'YYYY-MM-DD', el formato legacy ya soportado): un año cabe en ~400
// buckets. Trade-off: las ventanas de 1 sem/1 mes cuentan el día completo en
// el borde de corte.
const KEEP_HOURLY_DAYS = 7;

// Buckets por HORA (clave 'YYYY-MM-DDTHH', GMT-4): permiten ventanas de 1h/24h;
// los rangos de 1 sem / 1 mes agrupan por día. Los stats.json antiguos (claves
// 'YYYY-MM-DD') se conservan como buckets legacy y cuentan en ventanas largas.
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

export interface SeriesPoint {
  key: string;
  messages: number;
  aiCalls: number;
  tokens: number;
  cost: number;
}

export interface Rankings {
  totals: Totals;
  prev: Totals;
  series: SeriesPoint[];
  daily: Array<{ day: string; messages: number; aiCalls: Record<string, number>; tokensIn: number; tokensOut: number; tokensCached: number; cost: number }>;
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

function hourKey(d = new Date()): string {
  return gmt4Date(d).toISOString().slice(0, 13);
}

function dayKeyOf(d = new Date()): string {
  return gmt4Date(d).toISOString().slice(0, 10);
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

@Injectable()
export class StatsService implements OnModuleDestroy {
  private readonly logger = new Logger(StatsService.name);
  private buckets = new Map<string, DayStat>();
  private loadPromise: Promise<void> | null = null;

  constructor() {
    this.loadPromise = this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(STATS_FILE, 'utf-8'));
      // Buckets guardados con un esquema anterior quedan completos.
      this.buckets = new Map(Object.entries(raw).map(([k, d]) => [k, { ...emptyDay(), ...(d as DayStat) }]));
    } catch {
      // sin stats aún: empezar de cero
    }
  }

  private bucket(): DayStat {
    const key = hourKey();
    let b = this.buckets.get(key);
    if (!b) {
      b = emptyDay();
      this.buckets.set(key, b);
    }
    return b;
  }

  bumpMessage(userId: string): void {
    const b = this.bucket();
    b.messages++;
    bump(b.users, userId);
  }

  bumpAiCall(kind: string): void {
    bump(this.bucket().aiCalls, kind);
  }

  bumpCommand(command: string, userId: string): void {
    const b = this.bucket();
    bump(b.commands, command);
    const perUser = b.commandUsers[command] ?? (b.commandUsers[command] = {});
    bump(perUser, userId);
  }

  addTokens(inTok: number, outTok: number, cached = 0, cost = 0, model = ''): void {
    const b = this.bucket();
    b.tokensIn += inTok;
    b.tokensOut += outTok;
    b.tokensCached += cached;
    b.cost = (b.cost ?? 0) + cost;
    if (model) bump(b.models, model);
  }

  /** Borra todo el historial y lo persiste de inmediato. */
  async reset(): Promise<void> {
    await this.loadPromise;
    this.buckets.clear();
    try {
      await atomicWrite(STATS_FILE, '{}');
    } catch (e) {
      this.logger.warn(`No pude resetear stats: ${(e as Error).message}`);
    }
  }

  rankings(hours = 24): Rankings {
    const now = new Date();
    const curCutoff = hourKey(new Date(now.getTime() - hours * 3_600_000));
    const prevCutoff = hourKey(new Date(now.getTime() - 2 * hours * 3_600_000));

    let totals = emptyTotals();
    let prev = emptyTotals();
    const models: Record<string, number> = {};
    const users: Record<string, number> = {};
    const cmdCount: Record<string, number> = {};
    const cmdUsers: Record<string, Record<string, number>> = {};
    const byDay = new Map<string, number>();
    const dailyAgg = new Map<string, { day: string; messages: number; aiCalls: Record<string, number>; tokensIn: number; tokensOut: number; tokensCached: number; cost: number }>();
    const byHourFull = new Map<string, { messages: number; aiCalls: number; tokens: number; cost: number }>();

    for (const [key, b] of this.buckets) {
      if (key >= curCutoff) {
        totals.messages += b.messages;
        totals.tokensIn += b.tokensIn;
        totals.tokensOut += b.tokensOut;
        totals.tokensCached += b.tokensCached;
        totals.cost += b.cost ?? 0;
        totals.aiCalls += Object.values(b.aiCalls).reduce((a, c) => a + c, 0);
        for (const [m, n] of Object.entries(b.models)) models[m] = (models[m] ?? 0) + n;
        for (const [u, n] of Object.entries(b.users)) users[u] = (users[u] ?? 0) + n;
        for (const [c, n] of Object.entries(b.commands)) cmdCount[c] = (cmdCount[c] ?? 0) + n;
        for (const [c, perUser] of Object.entries(b.commandUsers)) {
          const acc = cmdUsers[c] ?? (cmdUsers[c] = {});
          for (const [u, n] of Object.entries(perUser)) acc[u] = (acc[u] ?? 0) + n;
        }
        const day = key.slice(0, 10);
        const d = dailyAgg.get(day) ?? { day, messages: 0, aiCalls: {}, tokensIn: 0, tokensOut: 0, tokensCached: 0, cost: 0 };
        d.messages += b.messages;
        d.tokensIn += b.tokensIn;
        d.tokensOut += b.tokensOut;
        d.tokensCached += b.tokensCached;
        d.cost += b.cost ?? 0;
        for (const [k, n] of Object.entries(b.aiCalls)) d.aiCalls[k] = (d.aiCalls[k] ?? 0) + n;
        dailyAgg.set(day, d);
        const h = byHourFull.get(key) ?? { messages: 0, aiCalls: 0, tokens: 0, cost: 0 };
        h.messages += b.messages;
        h.aiCalls += Object.values(b.aiCalls).reduce((a, c) => a + c, 0);
        h.tokens += b.tokensIn + b.tokensOut;
        h.cost += b.cost ?? 0;
        byHourFull.set(key, h);
      } else if (key >= prevCutoff) {
        prev.messages += b.messages;
        prev.tokensIn += b.tokensIn;
        prev.tokensOut += b.tokensOut;
        prev.tokensCached += b.tokensCached;
        prev.cost += b.cost ?? 0;
        prev.aiCalls += Object.values(b.aiCalls).reduce((a, c) => a + c, 0);
      }
      const day = key.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + b.messages);
    }

    // Serie del gráfico: por hora (1h/24h, inclusive la hora de corte) o por día
    // (1 sem / 1 mes).
    const series: SeriesPoint[] = [];
    if (hours <= 24) {
      for (let i = hours; i >= 0; i--) {
        const key = hourKey(new Date(now.getTime() - i * 3_600_000));
        const h = byHourFull.get(key);
        series.push({ key, messages: h?.messages ?? 0, aiCalls: h?.aiCalls ?? 0, tokens: h?.tokens ?? 0, cost: h?.cost ?? 0 });
      }
    } else {
      const days = Math.ceil(hours / 24);
      for (let i = days - 1; i >= 0; i--) {
        const key = dayKeyOf(new Date(now.getTime() - i * 86_400_000));
        const d = dailyAgg.get(key);
        series.push({
          key,
          messages: d?.messages ?? 0,
          aiCalls: d ? Object.values(d.aiCalls).reduce((a, c) => a + c, 0) : 0,
          tokens: (d?.tokensIn ?? 0) + (d?.tokensOut ?? 0),
          cost: d?.cost ?? 0,
        });
      }
    }

    const heatmap: Array<{ day: string; messages: number }> = [];
    for (let i = KEEP_DAYS - 1; i >= 0; i--) {
      const day = dayKeyOf(new Date(now.getTime() - i * 86_400_000));
      heatmap.push({ day, messages: byDay.get(day) ?? 0 });
    }

    return {
      totals,
      prev,
      series,
      daily: [...dailyAgg.values()].sort((a, b) => (a.day > b.day ? 1 : -1)),
      heatmap,
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

  // Fusiona el bucket horario en el de su día (mapas sumados) y lo borra.
  private compactToDay(hourKey: string): void {
    const h = this.buckets.get(hourKey)!;
    const dayKey = hourKey.slice(0, 10);
    let d = this.buckets.get(dayKey);
    if (!d) {
      d = emptyDay();
      this.buckets.set(dayKey, d);
    }
    d.messages += h.messages;
    d.tokensIn += h.tokensIn;
    d.tokensOut += h.tokensOut;
    d.tokensCached += h.tokensCached;
    d.cost += h.cost ?? 0;
    for (const [k, n] of Object.entries(h.aiCalls)) d.aiCalls[k] = (d.aiCalls[k] ?? 0) + n;
    for (const [k, n] of Object.entries(h.models)) d.models[k] = (d.models[k] ?? 0) + n;
    for (const [k, n] of Object.entries(h.users)) d.users[k] = (d.users[k] ?? 0) + n;
    for (const [k, n] of Object.entries(h.commands)) d.commands[k] = (d.commands[k] ?? 0) + n;
    for (const [cmd, perUser] of Object.entries(h.commandUsers)) {
      const acc = d.commandUsers[cmd] ?? (d.commandUsers[cmd] = {});
      for (const [u, n] of Object.entries(perUser)) acc[u] = (acc[u] ?? 0) + n;
    }
    this.buckets.delete(hourKey);
  }

  @Interval(60000)
  private async flush(): Promise<void> {
    await this.loadPromise;
    const now = new Date();
    const hourlyCutoff = dayKeyOf(new Date(now.getTime() - KEEP_HOURLY_DAYS * 86_400_000));
    const keepCutoff = dayKeyOf(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
    for (const key of [...this.buckets.keys()]) {
      const day = key.slice(0, 10);
      if (day < keepCutoff) this.buckets.delete(key);
      else if (key.length > 10 && day < hourlyCutoff) this.compactToDay(key);
    }
    try {
      await atomicWrite(STATS_FILE, JSON.stringify(Object.fromEntries(this.buckets)));
    } catch (e) {
      this.logger.warn(`No pude guardar stats: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }
}
