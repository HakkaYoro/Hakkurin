import { vi } from 'vitest';
import { DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DiscordAdapter } from '../src/discord/infrastructure/discord.adapter';
import { SmartResponseService } from '../src/discord/application/smart-response.service';
import { ReminderService } from '../src/discord/application/reminder.service';
import { HolidayService } from '../src/discord/application/holiday.service';
import { ConversationService } from '../src/conversation/application/conversation.service';
import { StealthDmService } from '../src/discord/application/stealth-dm.service';
import { SleepService } from '../src/discord/application/sleep.service';
import { ActionParserService } from '../src/scheduler/application/action-parser.service';
import { ConfigService } from '../src/common/config.service';
import { CryptoAdapter } from '../src/memory/infrastructure/persistence/crypto.adapter';
import { MemoryRepositoryAdapter } from '../src/memory/infrastructure/persistence/memory-repository.adapter';
import { MemoryQueueAdapter } from '../src/memory/infrastructure/persistence/memory-queue.adapter';
import { MemoryService, BOT_SELF_ID } from '../src/memory/application/memory.service';
import { MemoryEventsListener } from '../src/memory/application/memory-events.listener';
import {
  MessageTransportPort,
  SendOptions,
} from '../src/discord/domain/ports/message-transport.port';
import { BotStatePort } from '../src/discord/domain/ports/bot-state.port';
import { UrlContext, UrlEnricherPort } from '../src/discord/domain/ports/url-enricher.port';
import { HolidayStoreAdapter } from '../src/discord/infrastructure/persistence/holiday-store.adapter';
import { SleepStoreAdapter } from '../src/discord/infrastructure/persistence/sleep-store.adapter';

// Pipeline completo de DiscordAdapter con dependencias reales donde es barato
// (conversación, memoria cifrada real en tmp, stores de disco, parser) y fakes
// en los bordes de red (cliente de discord.js, brain, music).

const EMPTY_URL_CTX: UrlContext = { text: null, thumbnailData: null, thumbnailMime: null };

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
    guilds: { cache: new Map() },
    users: { fetch: vi.fn(async () => ({ username: 'Bob' })) },
    destroy: vi.fn(async () => {}),
  };
}

function makeService(store: Record<string, any> = {}, brain = makeBrain()) {
  const config = new MockConfig();
  Object.assign(config.store, store);
  const cryptoSvc = new CryptoAdapter();
  const events = new EventEmitter2();
  const memory = new MemoryService(cryptoSvc, new MemoryRepositoryAdapter(cryptoSvc), new MemoryQueueAdapter(), events);
  const conversation = new ConversationService(brain, memory);
  const parser = new ActionParserService();
  const music = { getNowPlaying: vi.fn(() => null), checkEmptyVoiceChannels: vi.fn(async () => {}) } as any;

  // Mismo ciclo que en producción (DiscordAdapter ↔ use-cases vía puertos): los
  // proxies delegan en la instancia que se crea un poco más abajo.
  const ref: { svc?: DiscordAdapter } = {};
  class LazyTransport extends MessageTransportPort {
    isChannelSendable(id: string) {
      return ref.svc!.isChannelSendable(id);
    }
    async sendTyping(id: string) {
      return ref.svc!.sendTyping(id);
    }
    async sendToChannel(id: string, content: string, opts?: SendOptions) {
      return ref.svc!.sendToChannel(id, content, opts);
    }
    async sendDm(userId: string, content: string, guildId?: string | null) {
      return ref.svc!.sendDm(userId, content, guildId);
    }
    async fetchImage(url: string) {
      return ref.svc!.fetchImage(url);
    }
    async fetchUsername(id: string) {
      return ref.svc!.fetchUsername(id);
    }
    logDmOutput(id: string, userName: string, userId: string, msgText: string) {
      ref.svc!.logDmOutput(id, userName, userId, msgText);
    }
    getBotUserId() {
      return ref.svc!.getBotUserId();
    }
  }
  class LazyState extends BotStatePort {
    async updateBotStatus(s?: 'online' | 'idle' | 'dnd', a?: string) {
      return ref.svc!.updateBotStatus(s, a);
    }
    setLastActiveChannel(id: string) {
      ref.svc!.setLastActiveChannel(id);
    }
    async performMemorySummarization(uid: string) {
      return ref.svc!.performMemorySummarization(uid);
    }
  }
  const transport = new LazyTransport();
  const state = new LazyState();
  const urlEnricher = { enrich: vi.fn(async () => EMPTY_URL_CTX) } as unknown as UrlEnricherPort;

  const stealthDm = new StealthDmService(transport);
  const sleep = new SleepService(new SleepStoreAdapter(), transport);
  // Mismo cableado que MemoryModule en producción: el listener encola la
  // respuesta del bot al recibir InteractionAnswered.
  new MemoryEventsListener(events, memory, config).listen(events);
  const smartResponse = new SmartResponseService(
    config, conversation, brain, memory,
    transport, state, urlEnricher, stealthDm, sleep, music, events,
  );
  const reminders = new ReminderService(memory, brain, parser, transport);
  const holidays = new HolidayService(memory, brain, transport, new HolidayStoreAdapter());
  const svc = new DiscordAdapter(
    config, conversation, brain, memory,
    stealthDm, sleep,
    music,
    { handle: vi.fn(async () => {}), register: vi.fn(async () => {}) } as any,
    parser,
    smartResponse, reminders, holidays,
  );
  ref.svc = svc;
  return { svc, config, memory, conversation, brain, client: makeClient() };
}

function fakeMsg(over: Record<string, any> = {}): any {
  return {
    id: 'm1',
    author: { bot: false, id: 'u1', displayName: 'Alice' },
    channel: {
      id: 'c1',
      type: 0,
      isTextBased: () => true,
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

describe('DiscordAdapter — pipeline de mensajes', () => {
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
    client.channels.cache.set('c1', msg.channel);
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
    const client = makeClient();
    (svc as any).client = client;
    const msg = fakeMsg({ mentions: { has: vi.fn(() => true), users: new Map() } });
    client.channels.cache.set('c1', msg.channel);
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

describe('DiscordAdapter — presencia y envío', () => {
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

  it('sendToChannel/sendMessageCallback: canal cacheado → typing + send; desconocido → false silencioso', async () => {
    vi.useFakeTimers();
    const { svc, client } = makeService();
    (svc as any).client = client;
    const channel = { isTextBased: () => true, sendTyping: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    client.channels.cache.set('cX', channel);

    await expect(svc.sendToChannel('cX', 'hola mundial')).resolves.toBe(true);
    expect(channel.sendTyping).not.toHaveBeenCalled(); // sin opts.typing no hay pausa
    expect(channel.send).toHaveBeenCalledWith('hola mundial');

    void svc.sendMessageCallback('cX', 'hola con typing');
    await vi.advanceTimersByTimeAsync(10000);
    expect(channel.send).toHaveBeenCalledWith('hola con typing');
    expect(channel.sendTyping).toHaveBeenCalled();

    await expect(svc.sendToChannel('desconocido', 'x')).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('sendToChannel con replyTo: reintenta sin cita si el mensaje referenciado fue borrado', async () => {
    const { svc, client } = makeService();
    (svc as any).client = client;
    const channel: any = { isTextBased: () => true, send: vi.fn(async () => {}) };
    client.channels.cache.set('c1', channel);
    // Error de API con code 10008 (mensaje referenciado borrado), como lo emite discord.js.
    const boom = Object.create(DiscordAPIError.prototype);
    boom.message = 'Unknown Message';
    boom.code = 10008;
    boom.status = 404;
    channel.send = vi.fn()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce({});

    await expect(
      svc.sendToChannel('c1', 'respuesta', { replyTo: { messageId: 'm9', channelId: 'c1' } }),
    ).resolves.toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[0][0]).toMatchObject({ content: 'respuesta', messageReference: { messageId: 'm9' } });
    expect(channel.send.mock.calls[1][0]).toBe('respuesta');
  });

  it('sendDm: miembro del guild primero; sin guild cae al usuario global', async () => {
    const { svc, client } = makeService();
    (svc as any).client = client;
    const memberSend = vi.fn(async () => {});
    const guild = { members: { fetch: vi.fn(async () => ({ send: memberSend })) } };
    client.guilds.cache.set('g1', guild);

    await expect(svc.sendDm('42', 'hola oculto', 'g1')).resolves.toBe(true);
    expect(guild.members.fetch).toHaveBeenCalledWith('42');
    expect(memberSend).toHaveBeenCalledWith('hola oculto');
    expect(client.users.fetch).not.toHaveBeenCalled();

    const userSend = vi.fn(async () => {});
    (client.users.fetch as any).mockResolvedValue({ send: userSend });
    await expect(svc.sendDm('43', 'dm global', null)).resolves.toBe(true);
    expect(client.users.fetch).toHaveBeenCalledWith('43');
    expect(userSend).toHaveBeenCalledWith('dm global');
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

describe('DiscordAdapter — memoria y loops', () => {
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

    // Dormido y vencido. enterSleep pasa por el pausa humanizada del transporte
    // → avanzar los timers en paralelo para completar el envío.
    const sleep: SleepService = (svc as any).sleep;
    void sleep.enterSleep('c9');
    await vi.advanceTimersByTimeAsync(10000);
    (sleep as any).sleepUntil = Math.floor(Date.now() / 1000) - 1;
    void svc.recoveryCheck();
    await vi.advanceTimersByTimeAsync(10000);
    expect(channel.send).toHaveBeenCalledWith('Ya volví.');
    expect(sleep.sleeping).toBe(false);
  });
});

describe('DiscordAdapter — festividades', () => {
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
