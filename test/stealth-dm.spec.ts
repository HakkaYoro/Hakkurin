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
