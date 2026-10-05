import { promises as fs } from 'fs';
import { SleepService } from '../src/discord/sleep.service';

// Modo sueño: frases desde status_messages.json, activación 2h y sonda de
// recuperación (despierta si la API sana, extiende 2h si sigue mal).

it('sin status_messages.json usa las frases por defecto', async () => {
  const s = new SleepService();
  await s.onModuleInit();
  expect(['Me voy a dormir.']).toContain(s.randomTired());
  expect(['Ya volví.']).toContain(s.randomRecovery());
});

it('carga frases personalizadas desde data/status_messages.json', async () => {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(
    'data/status_messages.json',
    JSON.stringify({ tired: ['zzz'], recovery: ['aquí estoy'] }),
  );
  const s = new SleepService();
  await s.onModuleInit();
  expect(s.randomTired()).toBe('zzz');
  expect(s.randomRecovery()).toBe('aquí estoy');
});

it('getters iniciales: despierta y wakeTime 0', () => {
  const s = new SleepService();
  expect(s.sleeping).toBe(false);
  expect(s.wakeTime).toBe(0);
});

it('enterSleep activa el modo 2h y envía la frase de cansancio vía callback', async () => {
  const s = new SleepService();
  const sent: string[] = [];
  await s.enterSleep(async (msg) => {
    sent.push(msg);
  });
  expect(s.sleeping).toBe(true);
  expect(sent).toEqual(['Me voy a dormir.']);
  const drift = Math.abs(s.wakeTime - (Date.now() / 1000 + 2 * 3600));
  expect(drift).toBeLessThan(5);
});

it('enterSleep no lanza aunque el callback falle (canal puede no existir)', async () => {
  const s = new SleepService();
  await expect(s.enterSleep(async () => { throw new Error('canal muerto'); })).resolves.toBeUndefined();
  expect(s.sleeping).toBe(true);
});

it('recoveryProbe: despierta no hace nada', async () => {
  const s = new SleepService();
  const r = await s.recoveryProbe(async () => true);
  expect(r).toEqual({ checked: false, recovered: false });
});

it('recoveryProbe: dentro de las 2h no consulta la API', async () => {
  const s = new SleepService();
  await s.enterSleep(async () => {});
  let apiCalls = 0;
  const r = await s.recoveryProbe(async () => { apiCalls++; return true; });
  expect(r.checked).toBe(false);
  expect(apiCalls).toBe(0);
});

it('recoveryProbe: pasado el tiempo + API sana → despierta', async () => {
  const s = new SleepService();
  await s.enterSleep(async () => {});
  (s as any).sleepUntil = Math.floor(Date.now() / 1000) - 1; // forzar vencimiento
  const r = await s.recoveryProbe(async () => true);
  expect(r).toEqual({ checked: true, recovered: true });
  expect(s.sleeping).toBe(false);
  expect(s.wakeTime).toBe(0);
});

it('recoveryProbe: API sigue mal → extiende otras 2h sin despertar', async () => {
  const s = new SleepService();
  await s.enterSleep(async () => {});
  (s as any).sleepUntil = Math.floor(Date.now() / 1000) - 1;
  const before = s.wakeTime;
  const r = await s.recoveryProbe(async () => false);
  expect(r).toEqual({ checked: true, recovered: false });
  expect(s.sleeping).toBe(true);
  expect(s.wakeTime).toBeGreaterThan(before);
  expect(Math.abs(s.wakeTime - (Date.now() / 1000 + 2 * 3600))).toBeLessThan(5);
});
