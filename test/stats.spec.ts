import * as fs from 'fs';
import { StatsService } from '../src/stats/stats.service';
import { atomicWrite } from '../src/common/util';

// StatsService instanciado a mano: el @Interval(60000) de flush no corre fuera del
// grafo DI, y el cwd tmp aislado por archivo (test/_setup.ts) contiene data/stats.json.

const FILE = 'data/stats.json';

const day = (over: Record<string, any> = {}) => ({
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
  ...over,
});

async function seed(days: Record<string, any>): Promise<StatsService> {
  await fs.promises.mkdir('data', { recursive: true });
  await atomicWrite(FILE, JSON.stringify(days));
  const svc = new StatsService();
  // load() es async: esperar a que el archivo sembrado sea visible.
  await vi.waitFor(() => expect(svc.rankings(30).heatmap.length).toBeGreaterThan(0));
  return svc;
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe('StatsService — contadores por usuario/comando/modelo', () => {
  it('bumpMessage/bumpCommand/addTokens alimentan los mapas del día', () => {
    const svc = new StatsService();
    svc.bumpMessage('u1');
    svc.bumpMessage('u1');
    svc.bumpMessage('u2');
    svc.bumpCommand('play', 'u1');
    svc.bumpCommand('play', 'u2');
    svc.bumpCommand('stop', 'u1');
    svc.addTokens(100, 20, 50, 0.01, 'deepseek/v3');
    svc.addTokens(10, 2, 0, 0); // sin modelo → no entra en models
    const today = svc.rankings(7).days.at(-1)!;
    expect(today.messages).toBe(3);
    expect(today.users).toEqual({ u1: 2, u2: 1 });
    expect(today.commands).toEqual({ play: 2, stop: 1 });
    expect(today.commandUsers.play).toEqual({ u1: 1, u2: 1 });
    expect(today.models).toEqual({ 'deepseek/v3': 1 });
    expect(today.tokensIn).toBe(110);
    expect(today.cost).toBeCloseTo(0.01);
  });
});

describe('StatsService — migración de días viejos', () => {
  it('un día sin users/commands/models carga con mapas vacíos', async () => {
    const svc = await seed({
      '2026-10-10': {
        messages: 4,
        aiCalls: { analyze: 2 },
        tokensIn: 10,
        tokensOut: 2,
        tokensCached: 1,
        cost: 0,
      },
    });
    const r = svc.rankings(7);
    expect(r.totals.messages).toBe(4);
    expect(r.totals.aiCalls).toBe(2);
    expect(r.days[0].users).toEqual({});
    expect(r.days[0].commands).toEqual({});
    expect(r.days[0].models).toEqual({});
  });
});

describe('StatsService — rankings', () => {
  it('ventana, período previo, orden cronológico y top usuario por comando', async () => {
    const svc = await seed({
      '2026-10-15': day({ messages: 1, users: { a: 1 }, commands: { play: 1 }, commandUsers: { play: { a: 1 } }, models: { 'm/viejo': 1 } }),
      '2026-10-16': day({ messages: 2, users: { a: 1, b: 1 }, commands: { play: 2 }, commandUsers: { play: { b: 2 } }, tokensIn: 20, tokensOut: 2, tokensCached: 5, cost: 0.2, models: { 'm/nuevo': 2 }, aiCalls: { analyze: 1 } }),
      '2026-10-17': day({ messages: 5, users: { b: 5 }, commands: { skip: 3 }, commandUsers: { skip: { b: 3 } }, tokensIn: 50, tokensOut: 5, tokensCached: 25, cost: 0.5, models: { 'm/nuevo': 3 }, aiCalls: { response: 2 } }),
    });

    const r = svc.rankings(2); // ventana = días 16 y 17
    expect(r.windowDays).toBe(2);
    expect(r.totals.messages).toBe(7);
    expect(r.totals.aiCalls).toBe(3);
    expect(r.totals.tokensCached).toBe(30);
    expect(r.prev.messages).toBe(1); // ventana previa = día 15
    expect(r.days.map((d) => d.day)).toEqual(['2026-10-16', '2026-10-17']); // cronológico asc
    expect(r.heatmap.map((h) => h.day)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
    expect(r.users).toEqual([
      { id: 'b', messages: 6 },
      { id: 'a', messages: 1 },
    ]);
    expect(r.commands).toEqual([
      { command: 'skip', count: 3, topUserId: 'b', topUserCount: 3 },
      { command: 'play', count: 2, topUserId: 'b', topUserCount: 2 },
    ]);
    expect(r.models).toEqual([{ model: 'm/nuevo', calls: 5 }]); // m/viejo queda fuera de la ventana
  });

  it('sin días → rankings vacíos pero bien formados', () => {
    const svc = new StatsService();
    const r = svc.rankings(7);
    expect(r.days).toEqual([]);
    expect(r.totals.messages).toBe(0);
    expect(r.users).toEqual([]);
    expect(r.commands).toEqual([]);
    expect(r.models).toEqual([]);
  });
});
