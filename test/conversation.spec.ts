import { ConversationService } from '../src/conversation/application/conversation.service';

// Sesiones + contexto de canal: las partes sin dependencias (brain/memory) se
// prueban directamente con mocks vacíos. check_timeouts depende del brain y se
// valida de forma integrada en el scheduler (Phase 6).

function makeService(): ConversationService {
  return new ConversationService({} as any, {} as any);
}

describe('ConversationService (sesiones + contexto de canal)', () => {
  it('createOrUpdateSession añade el mensaje al historial del canal formateado', () => {
    const svc = makeService();
    svc.createOrUpdateSession('c1', 'u1', 'Alice', 'hola');
    const history = svc.getChannelContext('c1').getFormattedHistory();
    expect(history).toEqual(['Alice (ID: u1): hola']);
  });

  it('getActiveUsers devuelve autores recientes del canal', () => {
    const svc = makeService();
    svc.createOrUpdateSession('c1', 'u1', 'Alice', 'a');
    svc.createOrUpdateSession('c1', 'u2', 'Bob', 'b');
    expect(svc.getActiveUsers('c1', 20).sort()).toEqual(['u1', 'u2']);
  });

  it('isBotEngaged es false al inicio y true tras updateBotActivity', () => {
    const svc = makeService();
    const ctx = svc.getChannelContext('c1');
    expect(ctx.isBotEngaged()).toBe(false);
    ctx.updateBotActivity();
    expect(ctx.isBotEngaged()).toBe(true);
  });

  it('endSession elimina la sesión (no lanza al re-consultar)', () => {
    const svc = makeService();
    svc.createOrUpdateSession('c1', 'u1', 'Alice', 'x');
    svc.endSession('c1', 'u1');
    // crear de nuevo no debe fallar
    const s = svc.createOrUpdateSession('c1', 'u1', 'Alice', 'y');
    expect(s.userId).toBe('u1');
  });

  it('getChannelContext es estable: mismo canal → misma instancia', () => {
    const svc = makeService();
    expect(svc.getChannelContext('c1')).toBe(svc.getChannelContext('c1'));
  });

  it('createOrUpdateSession reutiliza la sesión y refresca lastInteraction', () => {
    const svc = makeService();
    const s1 = svc.createOrUpdateSession('c1', 'u1');
    (s1 as any).lastInteraction = 1000; // envejecer
    const s2 = svc.createOrUpdateSession('c1', 'u1');
    expect(s2).toBe(s1);
    expect(s2.lastInteraction).toBeGreaterThan(1000);
  });

  it('sin userName/content no añade mensaje al historial', () => {
    const svc = makeService();
    svc.createOrUpdateSession('c1', 'u1');
    expect(svc.getChannelContext('c1').getFormattedHistory()).toEqual([]);
  });

  it('addImage + getRecentImages: ventana de 60s y devuelve data/mime', () => {
    const svc = makeService();
    const ctx = svc.getChannelContext('c1');
    ctx.addImage(Buffer.from('png'), 'image/png');
    const imgs = ctx.getRecentImages(60);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].mime).toBe('image/png');
    expect(imgs[0].data.toString()).toBe('png');
    // Ventana de 0s → nada
    expect(ctx.getRecentImages(0)).toEqual([]);
  });

  it('hasActiveSession refleja activate() de alguna sesión', () => {
    const svc = makeService();
    expect(svc.hasActiveSession()).toBe(false);
    const s = svc.createOrUpdateSession('c1', 'u1');
    s.isActive = true;
    expect(svc.hasActiveSession()).toBe(true);
  });

  describe('checkTimeouts (con brain fake)', () => {
    function makeWithBrain(brain: any) {
      return new ConversationService(brain, {} as any);
    }

    it('sesión activa expirada → timeout silencioso (7/8) y sesión eliminada', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // > 0.125 → silencioso
      const brain: any = { analyzeInteraction: vi.fn() };
      const svc = makeWithBrain(brain);
      const s = svc.createOrUpdateSession('c1', 'u1');
      s.isActive = true;
      (s as any).lastInteraction = Math.floor(Date.now() / 1000) - 400; // > 5min
      const sent: string[] = [];
      await svc.checkTimeouts(async (ch, text) => { sent.push(`${ch}:${text}`); });
      expect(brain.analyzeInteraction).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(svc.hasActiveSession()).toBe(false);
      vi.restoreAllMocks();
    });

    it('ramo de IA (12.5%): intent reply → envía máx 2 mensajes y elimina sesión', async () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.01) // < 0.125 → camino IA
        .mockReturnValue(0.5);
      const brain: any = {
        analyzeInteraction: vi.fn(async () => ({
          intent: 'reply',
          response_content: ['chao', 'vuelve pronto', 'tercero'],
          is_talking_to_me: true,
        })),
      };
      const svc = makeWithBrain(brain);
      const s = svc.createOrUpdateSession('c1', 'u1', 'Alice', 'hola');
      s.isActive = true;
      (s as any).lastInteraction = Math.floor(Date.now() / 1000) - 400;
      const sent: string[] = [];
      await svc.checkTimeouts(async (ch, text) => { sent.push(`${ch}:${text}`); });
      expect(brain.analyzeInteraction).toHaveBeenCalledTimes(1);
      const ctx = brain.analyzeInteraction.mock.calls[0][0];
      expect(ctx.userText).toContain('dejado de responder por 5 minutos');
      expect(ctx.contextMessages).toEqual(['Alice (ID: u1): hola']);
      expect(sent).toEqual(['c1:chao', 'c1:vuelve pronto']); // máx 2
      expect(svc.hasActiveSession()).toBe(false);
      vi.restoreAllMocks();
    });

    it('intent ignore del brain → no envía nada; error del brain tampoco rompe el loop', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.01); // camino IA
      const brain: any = {
        analyzeInteraction: vi.fn()
          .mockResolvedValueOnce({ intent: 'ignore', response_content: [] })
          .mockRejectedValueOnce(new Error('API muerta')),
      };
      const svc = makeWithBrain(brain);
      for (const uid of ['u1', 'u2']) {
        const s = svc.createOrUpdateSession('c1', uid);
        s.isActive = true;
        (s as any).lastInteraction = Math.floor(Date.now() / 1000) - 400;
      }
      const sent: string[] = [];
      await svc.checkTimeouts(async (ch, text) => { sent.push(`${ch}:${text}`); });
      expect(sent).toEqual([]);
      expect(svc.hasActiveSession()).toBe(false); // ambas sesiones procesadas pese al error
      vi.restoreAllMocks();
    });

    it('sesiones dentro de la ventana de 5min no se tocan', async () => {
      const brain: any = { analyzeInteraction: vi.fn() };
      const svc = makeWithBrain(brain);
      const s = svc.createOrUpdateSession('c1', 'u1');
      s.isActive = true; // recién creada → dentro de ventana
      await svc.checkTimeouts(async () => {});
      expect(svc.hasActiveSession()).toBe(true); // sigue activa
    });
  });
});
