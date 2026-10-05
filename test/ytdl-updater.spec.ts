import { YtdlUpdaterService } from '../src/music/ytdl-updater.service';
import { ConfigService } from '../src/common/config.service';

// Loop horario de auto-update de yt-dlp: solo actualiza con el bot idle y
// versiones distintas; los errores se tragan (reintenta la próxima hora).

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

afterEach(() => vi.unstubAllGlobals());

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

it('hay update y el bot está idle → POST /update al sidecar', async () => {
  const { svc } = makeService(true);
  const f = vi.fn(async (url: string, _init?: any) => ({
    ok: true,
    json: async () => ({ installed: '2026.09.14', latest: '2026.10.02' }),
  }));
  vi.stubGlobal('fetch', f);
  await svc.checkForUpdate();
  expect(f).toHaveBeenCalledTimes(2);
  expect(f.mock.calls[1][0]).toBe('http://sidecar.test:7654/update');
  expect(f.mock.calls[1][1]).toMatchObject({ method: 'POST' });
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
