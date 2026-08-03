import { ConversationService } from '../src/conversation/conversation.service';

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
});
