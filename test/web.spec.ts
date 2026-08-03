import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '../src/web/auth.guard';
import { ViewService } from '../src/web/view.service';

// Phase 5: el WebUI porteado corrige dos deudas del original (web/app.py):
//  (1) secretos write-only — bot_token/gemini_keys/navidrome_password no se hacen
//      echo al DOM; (2) auth opt-in vía webui_token. Cubrimos ambos + autoescape.

function ctx(headers: Record<string, string> = {}) {
  const res = { setHeader: () => res };
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => res }),
  } as any;
}
const cfg = (token: string | undefined) => ({ get: () => token } as any);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('AuthGuard', () => {
  it('sin webui_token → permite (localhost es la protección)', () => {
    expect(new AuthGuard(cfg(undefined)).canActivate(ctx())).toBe(true);
  });

  it('con token y sin Authorization → 401 + challenge Basic', () => {
    const g = new AuthGuard(cfg('sekret'));
    expect(() => g.canActivate(ctx())).toThrow(UnauthorizedException);
  });

  it('con token y password incorrecta → 401', () => {
    const g = new AuthGuard(cfg('sekret'));
    expect(() => g.canActivate(ctx({ authorization: `Basic ${b64('user:wrong')}` }))).toThrow(
      UnauthorizedException,
    );
  });

  it('con token y password correcta (Basic user:token) → permite', () => {
    const g = new AuthGuard(cfg('sekret'));
    expect(g.canActivate(ctx({ authorization: `Basic ${b64('user:sekret')}` }))).toBe(true);
  });
});

describe('ViewService (templates)', () => {
  const view = new ViewService();
  view.onModuleInit();

  const baseCtx = {
    bot_name: 'Hakkurin',
    system_prompt: 'prompt',
    reply_probability: 0.1,
    developer_id: '123',
    navidrome_base_url: '',
    navidrome_external_url: '',
    navidrome_username: '',
    has_bot_token: true,
    has_navidrome_password: false,
    gemini_keys_count: 2,
  };

  it('index: write-only — marca "Configurado" y NO hace echo del token', () => {
    const html = view.render('index.html', baseCtx);
    expect(html).toContain('Configurado'); // badge del token
    expect(html).toContain('2 configurada'); // cuenta de keys
    // El input del token siempre va vacío (value=""), el secreto nunca viaja al DOM.
    expect(html).not.toMatch(/name="bot_token"\s+value="[^"]/);
  });

  it('memories: lista vacía → mensaje y sin items', () => {
    const html = view.render('memories.html', { memories: [] });
    expect(html).toContain('No hay memorias');
  });

  it('memories: marca la memoria interna con internal-memory', () => {
    const html = view.render('memories.html', {
      memories: [{ user_id: 'self', date: '2026-01-01 00:00:00', is_self: true }],
    });
    expect(html).toContain('internal-memory');
    expect(html).toContain('MEMORIA INTERNA');
  });

  it('memory_view: autoescape — <script> en el contenido se escapa', () => {
    const html = view.render('memory_view.html', {
      user_id: 'x',
      content: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
