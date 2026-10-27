import { describe, expect, it } from 'vitest';
import { ContextBuilderService } from '../src/ai/application/context-builder.service';
import { ConfigService } from '../src/common/config.service';

class MockConfig extends ConfigService {
  store: Record<string, any> = {
    system_prompt: 'sp',
    developer_id: 'd',
    max_history_messages: 10,
  };
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeBuilder() {
  const calls = { summary: [] as string[], memory: [] as string[] };
  const memory: any = {
    getMemorySummary: async (uid: string) => {
      calls.summary.push(uid);
      return `resumen ${uid}`;
    },
    getMemory: async (uid: string) => {
      calls.memory.push(uid);
      return { summary: `solo-resumen ${uid}` };
    },
    getSelfMemory: async () => 'self',
  };
  return { svc: new ContextBuilderService(new MockConfig(), memory), calls };
}

describe('ContextBuilderService', () => {
  it('menciones <@id> cargan perfil con cola cruda además del hablante', async () => {
    const { svc, calls } = makeBuilder();
    await svc.buildInteractionPrompt({
      userText: 'hola <@111> y <@!222>',
      userId: '999',
      userName: 'u',
      contextMessages: [],
      activeUserIds: [],
    } as any);
    expect(calls.summary).toContain('999');
    expect(calls.summary).toContain('111');
    expect(calls.summary).toContain('222');
  });

  it('activos sin mención cargan SOLO resumen (sin cola cruda)', async () => {
    const { svc, calls } = makeBuilder();
    await svc.buildInteractionPrompt({
      userText: 'holi',
      userId: '999',
      userName: 'u',
      contextMessages: [],
      activeUserIds: ['777'],
    } as any);
    expect(calls.memory).toContain('777');
    expect(calls.summary).not.toContain('777');
  });

  it('historial recortado a max_history_messages antes del presupuesto de chars', async () => {
    const { svc } = makeBuilder();
    const msgs = Array.from({ length: 30 }, (_, i) => `M${i}: hola${i}`);
    const { prompt } = await svc.buildInteractionPrompt({
      userText: 'test',
      userId: '9',
      userName: 'u',
      contextMessages: msgs,
    } as any);
    expect(prompt).toContain('hola29');
    expect(prompt).not.toContain('hola5');
  });

  it('orden cache-friendly: estático → historial → volátiles → mensaje', async () => {
    const { svc } = makeBuilder();
    const { prompt } = await svc.buildInteractionPrompt({
      userText: 'test',
      userId: '9',
      userName: 'u',
      contextMessages: ['M1: anterior'],
      activeUserIds: [],
    } as any);
    // El cache es por prefijo: reglas y schema (estáticos) antes del historial;
    // la fecha con segundos al final para no romper el prefijo en cada llamada.
    expect(prompt.indexOf('TU TAREA')).toBeLessThan(prompt.indexOf('HISTORIAL RECIENTE'));
    expect(prompt.indexOf('REGLAS DE PERSONALIDAD')).toBeLessThan(prompt.indexOf('HISTORIAL RECIENTE'));
    expect(prompt.indexOf('HISTORIAL RECIENTE')).toBeLessThan(prompt.indexOf('DATOS INTERNOS'));
    expect(prompt.indexOf('DATOS INTERNOS')).toBeLessThan(prompt.indexOf('CONTEXTO DE USUARIOS'));
    expect(prompt.indexOf('CONTEXTO DE USUARIOS')).toBeLessThan(prompt.indexOf('FECHA Y HORA ACTUAL'));
    expect(prompt.indexOf('FECHA Y HORA ACTUAL')).toBeLessThan(prompt.indexOf('MENSAJE ACTUAL'));
  });
});
