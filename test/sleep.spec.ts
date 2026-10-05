import { promises as fs } from 'fs';
import { SleepService } from '../src/discord/application/sleep.service';
import { SleepStorePort, StatusMessages } from '../src/discord/domain/ports/json-store.port';
import { MessageTransportPort } from '../src/discord/domain/ports/message-transport.port';
import { SleepStoreAdapter } from '../src/discord/infrastructure/persistence/sleep-store.adapter';

// Modo sueño: frases desde el store, activación 2h y sonda de recuperación
// (despierta si la API sana, extiende 2h si sigue mal).

function makeStore(messages: StatusMessages = {}): SleepStorePort {
  return { loadStatusMessages: vi.fn(async () => messages) } as unknown as SleepStorePort;
}

function makeTransport(): MessageTransportPort {
  return { sendToChannel: vi.fn(async () => true) } as unknown as MessageTransportPort;
}

it('store sin frases usa las por defecto', async () => {
  const s = new SleepService(makeStore(), makeTransport());
  await s.onModuleInit();
  expect(['Me voy a dormir.']).toContain(s.randomTired());
  expect(['Ya volví.']).toContain(s.randomRecovery());
});

it('carga frases personalizadas desde el store', async () => {
  const s = new SleepService(makeStore({ tired: ['zzz'], recovery: ['aquí estoy'] }), makeTransport());
  await s.onModuleInit();
  expect(s.randomTired()).toBe('zzz');
  expect(s.randomRecovery()).toBe('aquí estoy');
});

describe('SleepStoreAdapter (fs real, cwd tmp por archivo)', () => {
  const FILE = 'data/status_messages.json';

  it('archivo ausente o inválido → {} sin lanzar', async () => {
    await fs.mkdir('data', { recursive: true });
    await fs.rm(FILE, { force: true });
    const adapter = new SleepStoreAdapter();
    await expect(adapter.loadStatusMessages()).resolves.toEqual({});

    await fs.writeFile(FILE, 'no-soy-json');
    await expect(adapter.loadStatusMessages()).resolves.toEqual({});
  });

  it('lee tired/recovery del JSON', async () => {
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(FILE, JSON.stringify({ tired: ['zzz'], recovery: ['aquí estoy'] }));
    const adapter = new SleepStoreAdapter();
    await expect(adapter.loadStatusMessages()).resolves.toEqual({
      tired: ['zzz'],
      recovery: ['aquí estoy'],
    });
  });
});

it('getters iniciales: despierta y wakeTime 0', () => {
  const s = new SleepService(makeStore(), makeTransport());
  expect(s.sleeping).toBe(false);
  expect(s.wakeTime).toBe(0);
});

it('enterSleep activa el modo 2h y envía la frase de cansancio por el transporte', async () => {
  const transport = makeTransport();
  const s = new SleepService(makeStore(), transport);
  await s.enterSleep('c1');
  expect(transport.sendToChannel).toHaveBeenCalledWith('c1', 'Me voy a dormir.', { typing: true });
  expect(s.sleeping).toBe(true);
  const drift = Math.abs(s.wakeTime - (Date.now() / 1000 + 2 * 3600));
  expect(drift).toBeLessThan(5);
});

it('enterSleep no lanza aunque el canal no acepte el envío (false del puerto)', async () => {
  const transport = { sendToChannel: vi.fn(async () => false) } as unknown as MessageTransportPort;
  const s = new SleepService(makeStore(), transport);
  await expect(s.enterSleep('canal-muerto')).resolves.toBeUndefined();
  expect(s.sleeping).toBe(true);
});

it('recoveryProbe: despierta no hace nada', async () => {
  const s = new SleepService(makeStore(), makeTransport());
  const r = await s.recoveryProbe(async () => true);
  expect(r).toEqual({ checked: false, recovered: false });
});

it('recoveryProbe: dentro de las 2h no consulta la API', async () => {
  const s = new SleepService(makeStore(), makeTransport());
  await s.enterSleep('c1');
  let apiCalls = 0;
  const r = await s.recoveryProbe(async () => { apiCalls++; return true; });
  expect(r.checked).toBe(false);
  expect(apiCalls).toBe(0);
});

it('recoveryProbe: pasado el tiempo + API sana → despierta', async () => {
  const s = new SleepService(makeStore(), makeTransport());
  await s.enterSleep('c1');
  (s as any).sleepUntil = Math.floor(Date.now() / 1000) - 1; // forzar vencimiento
  const r = await s.recoveryProbe(async () => true);
  expect(r).toEqual({ checked: true, recovered: true });
  expect(s.sleeping).toBe(false);
  expect(s.wakeTime).toBe(0);
});

it('recoveryProbe: API sigue mal → extiende otras 2h sin despertar', async () => {
  const s = new SleepService(makeStore(), makeTransport());
  await s.enterSleep('c1');
  (s as any).sleepUntil = Math.floor(Date.now() / 1000) - 1;
  const before = s.wakeTime;
  const r = await s.recoveryProbe(async () => false);
  expect(r).toEqual({ checked: true, recovered: false });
  expect(s.sleeping).toBe(true);
  expect(s.wakeTime).toBeGreaterThan(before);
  expect(Math.abs(s.wakeTime - (Date.now() / 1000 + 2 * 3600))).toBeLessThan(5);
});
