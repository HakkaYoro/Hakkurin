import * as fs from 'fs';
import { StatsService } from '../src/stats/stats.service';
import { atomicWrite, gmt4Date } from '../src/common/util';

// StatsService instanciado a mano: el @Interval(60000) de flush no corre fuera del
// grafo DI, y el cwd tmp aislado por archivo (test/_setup.ts) contiene data/stats.json.

const FILE = 'data/stats.json';

const bucket = (over: Record<string, any> = {}) => ({
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

// Claves de bucket relativas a ahora (el servicio corta por reloj, no por índice).
const hKey = (hoursAgo: number) => gmt4Date(new Date(Date.now() - hoursAgo * 3_600_000)).toISOString().slice(0, 13);

async function seed(days: Record<string, any>): Promise<StatsService> {
  await fs.promises.mkdir('data', { recursive: true });
  await atomicWrite(FILE, JSON.stringify(days));
  const svc = new StatsService();
  // load() es async: esperar a que el archivo sembrado sea visible.
  await vi.waitFor(() => expect(svc.rankings(720).totals.messages).toBeGreaterThan(0));
  return svc;
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe('StatsService — contadores por usuario/comando/modelo', () => {
  it('bumpMessage/bumpCommand/addTokens alimentan el bucket de la hora', async () => {
    const svc = new StatsService();
    svc.bumpMessage('u1');
    svc.bumpMessage('u1');
    svc.bumpMessage('u2');
    svc.bumpCommand('play', 'u1');
    svc.bumpCommand('play', 'u2');
    svc.bumpCommand('stop', 'u1');
    svc.addTokens(100, 20, 50, 0.01, 'deepseek/v3');
    svc.addTokens(10, 2, 0, 0); // sin modelo → no entra en models

    const r = svc.rankings(1); // ventana = la hora en curso
    expect(r.totals.messages).toBe(3);
    expect(r.totals.tokensIn).toBe(110);
    expect(r.totals.cost).toBeCloseTo(0.01);
    expect(r.users).toEqual([
      { id: 'u1', messages: 2 },
      { id: 'u2', messages: 1 },
    ]);
    expect(r.commands).toEqual([
      { command: 'play', count: 2, topUserId: 'u1', topUserCount: 1 },
      { command: 'stop', count: 1, topUserId: 'u1', topUserCount: 1 },
    ]);
    expect(r.models).toEqual([{ model: 'deepseek/v3', calls: 1 }]);
    expect(r.series).toHaveLength(2); // hora de corte + hora en curso
    expect(r.series.at(-1)!.messages).toBe(3);
    expect(r.series.at(-1)!.tokens).toBe(132);
  });
});

describe('StatsService — rankings por ventanas de horas', () => {
  it('ventana, período previo, serie horaria/diaria y heatmap de 30 días', async () => {
    const svc = await seed({
      [hKey(1)]: bucket({ messages: 5, users: { b: 5 }, commands: { skip: 3 }, commandUsers: { skip: { b: 3 } }, tokensIn: 50, tokensOut: 5, tokensCached: 25, cost: 0.5, models: { 'm/nuevo': 3 }, aiCalls: { response: 2 } }),
      [hKey(2)]: bucket({ messages: 2, users: { a: 1, b: 1 }, commands: { play: 2 }, commandUsers: { play: { b: 2 } }, tokensIn: 20, tokensOut: 2, tokensCached: 5, cost: 0.2, models: { 'm/nuevo': 2 }, aiCalls: { analyze: 1 } }),
      [hKey(30)]: bucket({ messages: 1, users: { a: 1 }, commands: { play: 1 }, commandUsers: { play: { a: 1 } }, models: { 'm/viejo': 1 } }),
    });

    const r24 = svc.rankings(24); // incluye h1 y h2; h30 queda en el período previo
    expect(r24.totals.messages).toBe(7);
    expect(r24.totals.aiCalls).toBe(3);
    expect(r24.prev.messages).toBe(1);
    expect(r24.series).toHaveLength(25); // serie horaria (24h + hora de corte)
    expect(r24.series.reduce((a, s) => a + s.messages, 0)).toBe(7);
    expect(r24.users).toEqual([
      { id: 'b', messages: 6 },
      { id: 'a', messages: 1 },
    ]);
    expect(r24.commands).toEqual([
      { command: 'skip', count: 3, topUserId: 'b', topUserCount: 3 },
      { command: 'play', count: 2, topUserId: 'b', topUserCount: 2 },
    ]);
    expect(r24.models).toEqual([{ model: 'm/nuevo', calls: 5 }]);

    const r1 = svc.rankings(1); // hora de corte + hora en curso
    expect(r1.totals.messages).toBe(5);
    expect(r1.prev.messages).toBe(2);
    expect(r1.series).toHaveLength(2);
    expect(r1.series.reduce((a, s) => a + s.messages, 0)).toBe(5);

    const r720 = svc.rankings(720); // serie diaria + h30 dentro de la ventana
    expect(r720.series).toHaveLength(30); // diaria
    expect(r720.series.reduce((a, s) => a + s.messages, 0)).toBe(8);
    expect(r720.models.map((m) => m.model)).toEqual(['m/nuevo', 'm/viejo']);
    expect(r720.heatmap).toHaveLength(30);
    expect(r720.heatmap.reduce((a, d) => a + d.messages, 0)).toBe(8);
  });

  it('sin buckets → rankings vacíos pero bien formados', () => {
    const svc = new StatsService();
    const r = svc.rankings(24);
    expect(r.series).toHaveLength(25);
    expect(r.series.every((s) => s.messages === 0)).toBe(true);
    expect(r.totals.messages).toBe(0);
    expect(r.users).toEqual([]);
    expect(r.commands).toEqual([]);
    expect(r.models).toEqual([]);
    expect(r.heatmap).toHaveLength(30);
  });
});

describe('StatsService — migración y reset', () => {
  it('un stats.json viejo con claves de día carga y cuenta en ventanas largas', async () => {
    const svc = await seed({
      // clave estilo esquema anterior (solo fecha): cuenta como bucket legacy
      [gmt4Date(new Date(Date.now() - 5 * 86_400_000)).toISOString().slice(0, 10)]: {
        messages: 4,
        aiCalls: { analyze: 2 },
        tokensIn: 10,
        tokensOut: 2,
        tokensCached: 1,
        cost: 0,
      },
    });
    const r = svc.rankings(720);
    expect(r.totals.messages).toBe(4);
    expect(r.totals.aiCalls).toBe(2);
    expect('users' in r.daily[0]).toBe(false); // el daily agregado no expone mapas
    expect(r.heatmap.reduce((a, d) => a + d.messages, 0)).toBe(4);
  });

  it('reset() vacía buckets y persiste {} de inmediato', async () => {
    const svc = await seed({
      [hKey(1)]: bucket({ messages: 9, users: { a: 9 } }),
    });
    await svc.reset();
    expect(svc.rankings(24).totals.messages).toBe(0);
    expect(fs.readFileSync(FILE, 'utf-8')).toBe('{}');
  });
});
