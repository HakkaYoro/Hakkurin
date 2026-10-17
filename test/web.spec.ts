import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '../src/web/infrastructure/auth.guard';
import { ViewService } from '../src/web/infrastructure/view.service';

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
    allowed_channels: 'ch1\nch2',
    ai_provider: 'gemini',
    openrouter_chat_model: '',
    openrouter_memory_model: '',
    max_history_messages: 20,
    deafen_move_enabled: false,
    deafen_move_channel_id: '',
    deafen_move_minutes: 3,
    navidrome_base_url: '',
    navidrome_external_url: '',
    navidrome_username: '',
    ytdl_sidecar_url: '',
    has_bot_token: true,
    has_navidrome_password: false,
    has_openrouter_key: false,
    has_webui_token: true,
    gemini_keys_count: 2,
    openrouter_configured: false,
    bot: { connected: true, uptimeS: 90, readySince: null, lastDisconnectAt: null },
    stats: [],
  };

  it('index: write-only — badge "Configurado" y sin echo de NINGÚN secreto', () => {
    const html = view.render('index.html', baseCtx);
    expect(html).toContain('Configurado'); // badge del token
    expect(html).toContain('2 configurada'); // cuenta de keys
    // Los inputs de secretos van siempre value="": el valor nunca viaja al DOM.
    expect(html).not.toMatch(/name="bot_token"\s+value="[^"]/);
    expect(html).not.toMatch(/name="navidrome_password"\s+value="[^"]/);
    expect(html).not.toMatch(/name="openrouter_api_key"\s+value="[^"]/);
    expect(html).not.toMatch(/name="webui_token"\s+value="[^"]/);
  });

  it('index: pestañas + status card alimentada por GET /status', () => {
    const html = view.render('index.html', baseCtx);
    expect(html).toContain('t-stats'); // tab de stats
    expect(html).toContain('Guardar cambios');
    expect(html).toContain('En línea'); // status card server-side
    expect(html).toContain("fetch('/status')"); // refresco cada 30s
    expect(html).toContain('allowed_channels');
    expect(html).toContain('name="deafen_move_enabled"');
  });

  it('index: tab stats — tabla con día, llamadas IA y % cacheado', () => {
    const html = view.render('index.html', {
      ...baseCtx,
      stats: [
        { day: '2026-10-16', messages: 9, aiCalls: { analyze: 4, response: 3 }, tokensIn: 100, tokensOut: 40, tokensCached: 25 },
      ],
    });
    expect(html).toContain('2026-10-16');
    expect(html).toContain('analyze: 4');
    expect(html).toContain('25%'); // 25 cached / 100 in
  });

  it('index: tab stats vacía — mensaje en vez de tabla', () => {
    const html = view.render('index.html', baseCtx);
    expect(html).toContain('Aún no hay datos');
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
