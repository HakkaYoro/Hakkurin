import { vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { DiscordService } from '../src/discord/discord.service';
import { ConversationService } from '../src/conversation/conversation.service';
import { StealthDmService } from '../src/discord/stealth-dm.service';
import { SleepService } from '../src/discord/sleep.service';
import { ActionParserService } from '../src/scheduler/action-parser.service';
import { ConfigService } from '../src/common/config.service';
import { CryptoService } from '../src/memory/crypto.service';
import { MemoryService, BOT_SELF_ID } from '../src/memory/memory.service';

// Pipeline completo de DiscordService con dependencias reales donde es barato
// (conversación, memoria cifrada real en tmp, stealth-dm, sleep, parser) y fakes
// de comportamiento en los bordes de red (cliente de discord.js, brain, music).

class MockConfig extends ConfigService {
  store: Record<string, any> = { reply_probability: 0 }; // sin trigger aleatorio: determinismo
  async load() {}
  async save() {}
  get<T = any>(key: string, d?: T): T {
    return (this.store[key] as T) ?? (d as T);
  }
}

function makeBrain(): any {
  return {
    analyzeInteraction: vi.fn(async () => ({ intent: 'ignore', response_content: [], is_talking_to_me: false })),
    generateSummary: vi.fn(async () => 'resumen nuevo'),
    generateHolidayGreeting: vi.fn(async () => 'feliz navidad baka'),
    generateResponse: vi.fn(async () => 'respuesta del recordatorio'),
    testApiConnection: vi.fn(async () => true),
    reloadConfig: vi.fn(async () => {}),
  };
}

function makeClient(): any {
  return {
    isReady: () => true,
    user: { id: 'botid', tag: 'Hakkurin#0001', setPresence: vi.fn(async () => {}) },
    channels: { cache: new Map() },
    users: { fetch: vi.fn(async () => ({ username: 'Bob' })) },
    destroy: vi.fn(async () => {}),
  };
}

function makeService(store: Record<string, any> = {}, brain = makeBrain()) {
  const config = new MockConfig();
  Object.assign(config.store, store);
  const memory = new MemoryService(new CryptoService());
  const conversation = new ConversationService(brain, memory);
  const svc = new DiscordService(
    config, conversation, brain, memory,
    new StealthDmService(), new SleepService(),
    { getNowPlaying: vi.fn(() => null), checkEmptyVoiceChannels: vi.fn(async () => {}) } as any,
    { handle: vi.fn(async () => {}), register: vi.fn(async () => {}) } as any,
    new ActionParserService(),
  );
  return { svc, config, memory, conversation, brain, client: makeClient() };
}

function fakeMsg(over: Record<string, any> = {}): any {
  return {
    id: 'm1',
    author: { bot: false, id: 'u1', displayName: 'Alice' },
    channel: {
      id: 'c1',
      type: 0,
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      messages: { cache: new Map() },
    },
    guild: {},
    guildId: 'g1',
    mentions: { has: vi.fn(() => false), users: new Map() },
    attachments: new Map(),
    content: 'hola',
    reference: null,
    member: null,
    ...over,
  };
}

async function memoryReady(memory: MemoryService) {
  await (memory as any).crypto.onModuleInit();
  await (memory as any).onModuleInit();
}

describe('DiscordService — pipeline de mensajes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('whitelist de canales: mensaje fuera → ni sesión ni IA', async () => {
    const { svc, conversation, brain } = makeService({ allowed_channels: ['c2'] });
    const msg = fakeMsg(); // canal c1
    await (svc as any).onMessage(msg);
    await vi.advanceTimersByTimeAsync(45000);
    expect(brain.analyzeInteraction).not.toHaveBeenCalled();
    expect(conversation.getActiveUsers('c1')).toEqual([]);
  });

  it('!sync se ignora sin gastar IA', async () => {
    const { svc, brain } = makeService();
    await (svc as any).onMessage(fakeMsg({ content: '!sync' }));
    await vi.advanceTimersByTimeAsync(45000);
    expect(brain.analyzeInteraction).not.toHaveBeenCalled();
  });

  it('mención → debounces 5s → analiza con contexto completo y envía los 2 mensajes', async () => {
    const brain = makeBrain();
    brain.analyzeInteraction = vi.fn(async () => ({
      intent: 'reply', response_content: ['hola', 'chao'], is_talking_to_me: true, ping_users: [],
    }));
    const { svc, conversation, memory } = makeService({}, brain);
    await memoryReady(memory);
    const client = makeClient();
    (svc as any).client = client;

    const mentions = { has: vi.fn(() => true), users: new Map() };
    const msg = fakeMsg({ mentions });
    void (svc as any).onMessage(msg);
    await vi.advanceTimersByTimeAsync(45000);

    expect(brain.analyzeInteraction).toHaveBeenCalledTimes(1);
    const ctx = brain.analyzeInteraction.mock.calls[0][0];
    expect(ctx.userText).toBe('hola');
    expect(ctx.userId).toBe('u1');
    expect(ctx.isSessionActive).toBe(true);
    expect(ctx.isDm).toBe(false);
    expect(ctx.contextMessages).toEqual(['Alice (ID: u1): hola']);

    // Envío: 1º con reference (is_talking_to_me y canal no "engaged"), 2º plano.
    expect(msg.channel.send).toHaveBeenCalledTimes(2);
    expect(msg.channel.send.mock.calls[0][0]).toMatchObject({
      content: 'hola',
      messageReference: { messageId: 'm1', channelId: 'c1' },
    });
    expect(msg.channel.send.mock.calls[1][0]).toBe('chao');

    // Efectos de memoria: interacción del usuario + respuesta del bot en cola.
    await vi.waitFor(async () => {
      const queued = await memory.getQueuedInteractions('u1');
      expect(queued).toContain('Usuario: hola');
      expect(queued).toContain('Hakkurin: hola chao');
    });
    // Contexto del canal registra la respuesta del bot (para futuros prompts).
    const history = conversation.getChannelContext('c1').getFormattedHistory();
    expect(history.some((h) => h.startsWith('Hakkurin (ID: botid): hola chao'))).toBe(true);
  });

  it('intent ignore → no envía nada y no toca memoria', async () => {
    const { svc, memory } = makeService();
    await memoryReady(memory);
    (svc as any).client = makeClient();
    const msg = fakeMsg({ mentions: { has: vi.fn(() => true), users: new Map() } });
    void (svc as any).onMessage(msg);
    await vi.advanceTimersByTimeAsync(45000);
    expect(msg.channel.send).not.toHaveBeenCalled();
    expect(await memory.getQueuedInteractions(BOT_SELF_ID)).toEqual([]);
  });

  it('intent error → modo sueño: presencia dnd + frase de cansancio al canal', async () => {
    const { svc, memory, brain } = makeService();
    await memoryReady(memory);
    const client = makeClient();
    (svc as any).client = client;
    const channel = { isTextBased: () => true, sendTyping: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    client.channels.cache.set('c1', channel);
    brain.analyzeInteraction = vi.fn(async () => ({
      intent: 'error', response_content: [], is_talking_to_me: false,
    }));

    const msg = fakeMsg({ mentions: { has: vi.fn(() => true), users: new Map() } });
    void (svc as any).onMessage(msg);
    await vi.advanceTimersByTimeAsync(45000);
    expect(client.user.setPresence).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dnd' }),
    );
    expect(channel.send).toHaveBeenCalledWith('Me voy a dormir.');
  });

  it('typing de otro usuario cancela la generación pendiente (no gasta IA)', async () => {
    const { svc, brain } = makeService();
    (svc as any).client = makeClient();
    const msg = fakeMsg({ mentions: { has: vi.fn(() => true), users: new Map() } });
    void (svc as any).onMessage(msg);
    await vi.advanceTimersByTimeAsync(1000); // dentro del debounce
    (svc as any).onTypingStart('c1', 'u2');
    await vi.advanceTimersByTimeAsync(45000);
    expect(brain.analyzeInteraction).not.toHaveBeenCalled();
  });

  it('debounce: mensajes seguidos del mismo usuario reemplazan la tarea pendiente', async () => {
    const brain = makeBrain();
    brain.analyzeInteraction = vi.fn(async () => ({
      intent: 'reply', response_content: ['ok'], is_talking_to_me: true, ping_users: [],
    }));
    const { svc } = makeService({}, brain);
    (svc as any).client = makeClient();
    const msg1 = fakeMsg({ id: 'm1', content: 'primer mensaje', mentions: { has: vi.fn(() => true), users: new Map() } });
    const msg2 = fakeMsg({ id: 'm2', content: 'segundo mensaje', mentions: { has: vi.fn(() => true), users: new Map() } });
    void (svc as any).onMessage(msg1);
    void (svc as any).onMessage(msg2);
    await vi.advanceTimersByTimeAsync(1000); // dentro de la ventana de debounce (5s)
    expect(brain.analyzeInteraction).not.toHaveBeenCalled(); // el 2º canceló al 1º
    await vi.advanceTimersByTimeAsync(45000);
    expect(brain.analyzeInteraction).toHaveBeenCalledTimes(1);
    expect(brain.analyzeInteraction.mock.calls[0][0].userText).toBe('segundo mensaje');
  });
});

describe('DiscordService — presencia y envío por callback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('updateBotStatus mapea online/idle/dnd con textos por defecto', async () => {
    const { svc, client } = makeService();
    (svc as any).client = client;
    await svc.updateBotStatus('online');
    expect(client.user.setPresence).toHaveBeenCalledWith({
      status: 'online', activities: [{ name: 'Conversando', type: 0 }],
    });
    await svc.updateBotStatus('dnd', 'texto custom');
    expect(client.user.setPresence).toHaveBeenLastCalledWith({
      status: 'dnd', activities: [{ name: 'texto custom', type: 0 }],
    });
  });

  it('updateBotStatus sin cliente listo → no-op', async () => {
    const { svc, client } = makeService();
    (svc as any).client = { ...client, isReady: () => false };
    await svc.updateBotStatus('online');
    expect(client.user.setPresence).not.toHaveBeenCalled();
  });

  it('sendMessageCallback: canal cacheado → typing + send; desconocido → silencio', async () => {
    vi.useFakeTimers();
    const { svc, client } = makeService();
    (svc as any).client = client;
    const channel = { isTextBased: () => true, sendTyping: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    client.channels.cache.set('cX', channel);

    void svc.sendMessageCallback('cX', 'hola mundial');
    await vi.advanceTimersByTimeAsync(10000);
    expect(channel.send).toHaveBeenCalledWith('hola mundial');

    await expect(svc.sendMessageCallback('desconocido', 'x')).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('isAdmin: solo miembros con permiso Administrator', () => {
    const { svc } = makeService();
    const admin = { member: { permissions: { has: vi.fn((p: bigint) => p === PermissionFlagsBits.Administrator) } } };
    expect(svc.isAdmin(admin as any)).toBe(true);
    const pleb = { member: { permissions: { has: vi.fn(() => false) } } };
    expect(svc.isAdmin(pleb as any)).toBe(false);
    expect(svc.isAdmin({ member: null } as any)).toBe(false);
  });
});

describe('DiscordService — memoria y loops', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('performMemorySummarization: buffer vacío no llama al brain; con buffer resume y guarda', async () => {
    const { svc, memory, brain } = makeService();
    await memoryReady(memory);
    await svc.performMemorySummarization('40');
    expect(brain.generateSummary).not.toHaveBeenCalled();

    await memory.addInteraction('40', 'primera');
    await memory.addInteraction('40', 'segunda');
    await svc.performMemorySummarization('40');
    expect(brain.generateSummary).toHaveBeenCalledWith('', ['primera', 'segunda'], '40');
    expect(await memory.getMemorySummary('40')).toContain('resumen nuevo');
    expect((await memory.getBufferAndSummary('40')).buffer).toEqual([]); // buffer consumido
  });

  it('forceShutdownAndSummarize resume pendientes y destruye el cliente', async () => {
    const { svc, memory, brain, client } = makeService();
    await memoryReady(memory);
    (svc as any).client = client;
    await memory.addInteraction('41', 'pendiente');
    await svc.forceShutdownAndSummarize();
    expect(brain.generateSummary).toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('processMemoryQueueLoop promueve la cola >5min y dispara el resumen', async () => {
    const { svc, memory, brain } = makeService();
    await memoryReady(memory);
    await memory.addToQueue('42', 'texto viejo');
    // Envejecer la entrada escribiendo la cola a mano (timestamp 0).
    const fsPromises = await import('fs/promises');
    await fsPromises.mkdir('data/memory', { recursive: true });
    await fsPromises.writeFile('data/memory/queue.json', JSON.stringify([{ user_id: '42', text: 'texto viejo', timestamp: 0 }]));

    await svc.processMemoryQueueLoop();
    // El resumen corre en promesas flotantes con fs real → esperar con polling real.
    await vi.waitFor(() => expect(brain.generateSummary).toHaveBeenCalled());
    expect(brain.generateSummary).toHaveBeenCalledWith('', ['texto viejo'], '42');
    expect(await memory.getQueuedInteractions('42')).toEqual([]);
  });

  it('checkReminders: ejecuta el recordatorio due, lo marca y lo borra de la memoria', async () => {
    const { svc, memory, brain, client } = makeService();
    await memoryReady(memory);
    (svc as any).client = client;

    const d = new Date(Date.now() - 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const trigger = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const memoryText = `### SCHEDULED_ACTIONS (JSON)\n\`\`\`json\n[{"trigger_time":"${trigger}","action_description":"regalar pizza","target_user_id":"42","target_user_name":"Bob"}]\n\`\`\``;
    await memory.updateSummary(BOT_SELF_ID, memoryText, null);
    await memory.updateLastChannel('42', '555');

    const channel = { isTextBased: () => true, send: vi.fn(async () => {}) };
    client.channels.cache.set('555', channel);

    await svc.checkReminders();
    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
    const [prompt, ctxId, userName] = brain.generateResponse.mock.calls[0];
    expect(prompt).toContain('regalar pizza');
    expect(ctxId).toBe('42');
    expect(userName).toBe('Bob');
    expect(channel.send).toHaveBeenCalledWith('respuesta del recordatorio');
    // Marcado en memoria: accion ejecutada + nota self.
    const { buffer } = await memory.getBufferAndSummary(BOT_SELF_ID);
    expect(buffer.some((b) => b.includes('EJECUTÉ RECORDATORIO: regalar pizza'))).toBe(true);
    const cleaned = await memory.getSelfMemory();
    expect(cleaned).not.toContain('regalar pizza');

    // Segunda pasada: dedupe in-memory → sin re-envío.
    await svc.checkReminders();
    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('checkReminders: sin acciones due → no hace nada', async () => {
    const { svc, brain } = makeService();
    await svc.checkReminders();
    expect(brain.generateResponse).not.toHaveBeenCalled();
  });

  it('recoveryCheck: dormido + vencido + API sana → despierta y avisa al último canal', async () => {
    const { svc, client } = makeService();
    (svc as any).client = client;
    (svc as any).lastActiveChannelId = 'c9';
    const channel = { isTextBased: () => true, sendTyping: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    client.channels.cache.set('c9', channel);

    // Despierto → no-op.
    await svc.recoveryCheck();
    expect(channel.send).not.toHaveBeenCalled();

    // Dormido y vencido.
    const sleep: SleepService = (svc as any).sleep;
    await sleep.enterSleep(async () => {});
    (sleep as any).sleepUntil = Math.floor(Date.now() / 1000) - 1;
    void svc.recoveryCheck();
    await vi.advanceTimersByTimeAsync(10000);
    expect(channel.send).toHaveBeenCalledWith('Ya volví.');
    expect(sleep.sleeping).toBe(false);
  });
});

describe('DiscordService — festividades', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('checkHolidays en Navidad (00:01 GMT-4) celebra una única vez y persiste el dedupe', async () => {
    vi.setSystemTime(new Date('2026-12-25T04:01:00Z')); // 00:01 GMT-4 del 25/12
    const { svc, memory, brain, client } = makeService();
    await memoryReady(memory);
    (svc as any).client = client;
    await memory.updateLastChannel('50', '777');
    const channel = { isTextBased: () => true, sendTyping: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    client.channels.cache.set('777', channel);

    void svc.checkHolidays();
    // celebrateHoliday cuelga de fs real → el avance de timers + waitFor.
    await vi.waitFor(() => expect(brain.generateHolidayGreeting).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10000);

    expect(channel.send).toHaveBeenCalledWith('<@50> feliz navidad baka');
    const saved = JSON.parse(await (await import('fs/promises')).readFile('data/holidays.json', 'utf-8'));
    expect(saved.xmas_2026).toBe(true);

    // Re-ejecución el mismo día → dedupe por archivo.
    await svc.checkHolidays();
    expect(brain.generateHolidayGreeting).toHaveBeenCalledTimes(1);
  });

  it('celebrateHoliday salta usuarios sin canal conocido (no gasta LLM)', async () => {
    const { svc, memory, brain, client } = makeService();
    await memoryReady(memory);
    (svc as any).client = client;
    await memory.saveMemory('51', { last_channel_id: null } as any); // sin canal
    await svc.celebrateHoliday('Año Nuevo');
    expect(brain.generateHolidayGreeting).not.toHaveBeenCalled();
  });
});
