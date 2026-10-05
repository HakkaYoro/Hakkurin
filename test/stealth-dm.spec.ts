import { StealthDmService } from '../src/discord/stealth-dm.service';

// El "DM invisible" usa regex fieles al fuente Python (docs/03 §3).
// La variante de cierre admite [/MD], /MD] y EOF. Nunca debe romper el envío
// público si el cierre está malformado.

const svc = new StealthDmService();

describe('StealthDmService extract/strip', () => {
  it('extrae un bloque bien cerrado y lo quita del texto público', () => {
    const text = '[MD:123]hola secreto[/MD] mundo visible';
    expect(svc.extractDms(text)).toEqual([{ targetUid: '123', msg: 'hola secreto' }]);
    expect(svc.stripDms(text)).toBe('mundo visible');
  });

  it('extrae varios bloques en el mismo mensaje', () => {
    const text = '[MD:1]a[/MD] y [MD:2]b[/MD]';
    expect(svc.extractDms(text)).toEqual([
      { targetUid: '1', msg: 'a' },
      { targetUid: '2', msg: 'b' },
    ]);
  });

  it('tolera cierre malformado (/MD] sin corchete) hasta EOF', () => {
    expect(svc.extractDms('[MD:99]texto /MD]')).toEqual([{ targetUid: '99', msg: 'texto' }]);
  });

  it('sin cierre: captura hasta el final del texto', () => {
    expect(svc.extractDms('[MD:7]sin cerrar nunca')).toEqual([
      { targetUid: '7', msg: 'sin cerrar nunca' },
    ]);
  });

  it('mensaje con saltos de línea dentro del bloque (flag dotall)', () => {
    const text = '[MD:5]linea uno\nlinea dos[/MD] ok';
    expect(svc.extractDms(text)).toEqual([{ targetUid: '5', msg: 'linea uno\nlinea dos' }]);
  });

  it('strip deja el texto público intacto si no hay bloques', () => {
    expect(svc.stripDms('mensaje normal sin dm')).toBe('mensaje normal sin dm');
  });
});

// Envío real de DMs: scheduleDelayedDms (3s) + sendStealthDm con fakes de discord.js.
describe('StealthDmService — envío', () => {
  let svc: StealthDmService;
  beforeEach(() => { svc = new StealthDmService(); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeMessage(guild: any) {
    return { guild } as any;
  }

  it('sendStealthDm resuelve por guild.members.fetch y envía el DM', async () => {
    const send = vi.fn(async () => {});
    const message = fakeMessage({ members: { fetch: vi.fn(async () => ({ send })) } });
    const client = { users: { fetch: vi.fn() } };
    await svc.sendStealthDm(message, '123', 'hola oculto', client as any);
    expect(send).toHaveBeenCalledWith('hola oculto');
    expect(client.users.fetch).not.toHaveBeenCalled();
  });

  it('no está en el guild → cae a client.users.fetch', async () => {
    const send = vi.fn(async () => {});
    const message = fakeMessage(null);
    const client = { users: { fetch: vi.fn(async () => ({ send })) } };
    await svc.sendStealthDm(message, '456', 'dm', client as any);
    expect(client.users.fetch).toHaveBeenCalledWith('456');
    expect(send).toHaveBeenCalledWith('dm');
  });

  it('id no numérico → no-op silencioso', async () => {
    const fetchGuild = vi.fn();
    const message = fakeMessage({ members: { fetch: fetchGuild } });
    const client = { users: { fetch: vi.fn() } };
    await svc.sendStealthDm(message, 'no-soy-id', 'x', client as any);
    expect(fetchGuild).not.toHaveBeenCalled();
    expect(client.users.fetch).not.toHaveBeenCalled();
  });

  it('fetch falla en ambos → nunca lanza', async () => {
    const message = fakeMessage({ members: { fetch: vi.fn(async () => { throw new Error('unknown member'); }) } });
    const client = { users: { fetch: vi.fn(async () => { throw new Error('unknown user'); }) } };
    await expect(svc.sendStealthDm(message, '789', 'x', client as any)).resolves.toBeUndefined();
  });

  it('scheduleDelayedDms sin dms → no programa nada', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    svc.scheduleDelayedDms(fakeMessage(null), [], {} as any);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('scheduleDelayedDms envía cada DM ~3s después (timers falsos)', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});
    const message = fakeMessage({ members: { fetch: vi.fn(async () => ({ send })) } });
    svc.scheduleDelayedDms(message, [{ targetUid: '1', msg: 'a' }, { targetUid: '2', msg: 'b' }], {} as any);
    await vi.advanceTimersByTimeAsync(3100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'a');
    expect(send).toHaveBeenNthCalledWith(2, 'b');
  });
});
