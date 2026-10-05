import { vi } from 'vitest';
import { StealthDmService } from '../src/discord/application/stealth-dm.service';
import { MessageTransportPort } from '../src/discord/domain/ports/message-transport.port';

// El "DM invisible" usa regex fieles al fuente Python (docs/03 §3).
// La variante de cierre admite [/MD], /MD] y EOF. Nunca debe romper el envío
// público si el cierre está malformado.

function makeTransport(over: Partial<MessageTransportPort> = {}): MessageTransportPort {
  return { sendDm: vi.fn(async () => true), ...over } as unknown as MessageTransportPort;
}

const svc = new StealthDmService(makeTransport());

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

// Envío real de DMs: scheduleDelayedDms (3s) delega en MessageTransportPort.sendDm.
describe('StealthDmService — envío', () => {
  let transport: MessageTransportPort;
  let svc: StealthDmService;
  beforeEach(() => {
    transport = makeTransport();
    svc = new StealthDmService(transport);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sendStealthDm delega en el transporte con el guild del mensaje', async () => {
    await svc.sendStealthDm('123', 'hola oculto', 'g1');
    expect(transport.sendDm).toHaveBeenCalledWith('123', 'hola oculto', 'g1');
  });

  it('sendDm falla (DMs cerrados) → no lanza y sin log de éxito', async () => {
    (transport.sendDm as any) = vi.fn(async () => false);
    await expect(svc.sendStealthDm('123', 'x', null)).resolves.toBeUndefined();
    expect(transport.sendDm).toHaveBeenCalled();
  });

  it('id no numérico → no consulta el transporte', async () => {
    await svc.sendStealthDm('no-soy-id', 'x', 'g1');
    expect(transport.sendDm).not.toHaveBeenCalled();
  });

  it('scheduleDelayedDms sin dms → no programa nada', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    svc.scheduleDelayedDms(null, []);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('scheduleDelayedDms envía cada DM ~3s después (timers falsos)', async () => {
    vi.useFakeTimers();
    svc.scheduleDelayedDms('g1', [
      { targetUid: '1', msg: 'a' },
      { targetUid: '2', msg: 'b' },
    ]);
    await vi.advanceTimersByTimeAsync(3100);
    expect(transport.sendDm).toHaveBeenCalledTimes(2);
    expect(transport.sendDm).toHaveBeenNthCalledWith(1, '1', 'a', 'g1');
    expect(transport.sendDm).toHaveBeenNthCalledWith(2, '2', 'b', 'g1');
  });
});
