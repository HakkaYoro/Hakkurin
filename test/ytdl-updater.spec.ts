import { YtdlUpdaterService } from '../src/music/infrastructure/ytdl-updater.service';
import { ConfigService } from '../src/common/config.service';

// Loop horario de auto-update de yt-dlp: solo actualiza con el bot idle y
// versiones distintas; los errores se tragan (reintenta la próxima hora).
// Tras el update hay poll de /health (fake timers: delays de 5s reales no).

class MockConfig extends ConfigService {
  store: Record<string, any> = { ytdl_sidecar_url: 'http://sidecar.test:7654' };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeService(isIdle = true) {
  const music = { isIdle: vi.fn(() => isIdle) } as any;
  const svc = new YtdlUpdaterService(new MockConfig(), music);
  return { svc, music };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('suena algo → ni consulta versiones ni toca el sidecar', async () => {
  const { svc, music } = makeService(false);
  const f = vi.fn();
  vi.stubGlobal('fetch', f);
  await svc.checkForUpdate();
  expect(music.isIdle).toHaveBeenCalledTimes(1);
  expect(f).not.toHaveBeenCalled();
});

it('versiones iguales → solo consulta, sin POST /update', async () => {
  const { svc } = makeService(true);
  const f = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ installed: '2026.10.02', latest: '2026.10.02' }),
  }));
  vi.stubGlobal('fetch', f);
  await svc.checkForUpdate();
  expect(f).toHaveBeenCalledTimes(1);
  expect(String(f.mock.calls[0][0])).toBe('http://sidecar.test:7654/version');
});

it('PyPI normaliza ceros (2026.08.19 vs 2026.8.19) y sidecar dice up_to_date → sin update', async () => {
  // Regresión: por string nunca eran iguales → reinicio inútil del sidecar cada hora.
  const { svc } = makeService(true);
  const f = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ installed: '2026.08.19', latest: '2026.8.19', up_to_date: true }),
  }));
  vi.stubGlobal('fetch', f);
  await svc.checkForUpdate();
  expect(f).toHaveBeenCalledTimes(1); // solo /version
});

it('hay update y el bot está idle → POST /update y poll de /health', async () => {
  const { svc } = makeService(true);
  const f = vi.fn(async (url: string, _init?: any) => ({
    ok: true,
    json: async () => ({ installed: '2026.09.14', latest: '2026.10.02' }),
  }));
  vi.stubGlobal('fetch', f);
  const p = svc.checkForUpdate();
  await vi.runAllTimersAsync();
  await p;
  expect(f.mock.calls[1][0]).toBe('http://sidecar.test:7654/update');
  expect(f.mock.calls[1][1]).toMatchObject({ method: 'POST' });
  expect(String(f.mock.calls[2][0])).toBe('http://sidecar.test:7654/health');
});

it('sidecar vuelve tras el update → log sin error', async () => {
  const { svc } = makeService(true);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ installed: '2026.09.14', latest: '2026.10.02' }),
  })));
  const errSpy = vi.spyOn((svc as any).logger, 'error');
  const p = svc.checkForUpdate();
  await vi.runAllTimersAsync();
  await p;
  expect(errSpy).not.toHaveBeenCalled();
});

it('sidecar NO vuelve tras el update → error visible (crash-loop)', async () => {
  const { svc } = makeService(true);
  const f = vi.fn(async (url: string) => {
    if (String(url).includes('/health')) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ installed: '2026.09.14', latest: '2026.10.02' }) };
  });
  vi.stubGlobal('fetch', f);
  const errSpy = vi.spyOn((svc as any).logger, 'error');
  const p = svc.checkForUpdate();
  await vi.runAllTimersAsync();
  await p;
  expect(errSpy).toHaveBeenCalled();
  const healthCalls = f.mock.calls.filter((c: any[]) => String(c[0]).includes('/health')).length;
  expect(healthCalls).toBeGreaterThanOrEqual(10); // sondeó todo el deadline de 60s
});

it('empieza a sonar algo entre el chequeo y el update → no actualiza', async () => {
  const { svc, music } = makeService(true);
  (music.isIdle as any).mockReturnValueOnce(true).mockReturnValueOnce(false);
  const f = vi.fn(async () => ({
    ok: true,
    json: async () => ({ installed: '2026.09.14', latest: '2026.10.02' }),
  }));
  vi.stubGlobal('fetch', f);
  await svc.checkForUpdate();
  expect(f).toHaveBeenCalledTimes(1); // solo /version, sin /update
});

it('sidecar caído → aviso y sin crash (reintenta la próxima hora)', async () => {
  const { svc } = makeService(true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  await expect(svc.checkForUpdate()).resolves.toBeUndefined();
});

it('respuesta /version incompleta → no postea update', async () => {
  const { svc } = makeService(true);
  const f = vi.fn(async () => ({ ok: true, json: async () => ({ installed: 'x' }) })); // sin latest
  vi.stubGlobal('fetch', f);
  await svc.checkForUpdate();
  expect(f).toHaveBeenCalledTimes(1);
});
