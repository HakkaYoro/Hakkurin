// Puerto de bot/discord_client.py (gateway + pipeline de mensajes).
// discord.js directo (sin necord): el pipeline necesita control imperativo del
// Client (cancelación por typing, debounce abortable) y el POST /restart del WebUI
// requiere destruir+recrear el cliente. Los 6 slash commands se registran en
// onReady en Phase 4. Los loops @tasks (timeouts/holidays/queue/recovery/reminders)
// son Phase 6 y llaman a los métodos públicos de aquí. Hexagonal: los use-cases
// (respuesta inteligente, recordatorios, festividades) viven en sus propios
// servicios; este clase es gateway + scheduler y delega en ellos.
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ActivityType,
  Client,
  DMChannel,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  type Message,
} from 'discord.js';
import type { AiBrain } from '../ai/ai-brain.interface';
import { ConfigService } from '../common/config.service';
import { MemoryService } from '../memory/memory.service';
import { ConversationService } from '../conversation/conversation.service';
import { StealthDmService } from './stealth-dm.service';
import { SleepService } from './sleep.service';
import { SlashCommandsService } from './slash-commands.service';
import { MusicService } from '../music/music.service';
import { ActionParserService } from '../scheduler/action-parser.service';
import { delay, sleepMs } from '../common/util';
import { ABORTED, SmartResponseService } from './smart-response.service';
import { ReminderService } from './reminder.service';
import { HolidayService } from './holiday.service';

@Injectable()
export class DiscordService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiscordService.name);
  private client: Client | null = null;
  private ready: Promise<void>;
  private readyResolve!: () => void;

  // key `${channelId}:${userId}` → controller abortable (debounce/cancel).
  private readonly pending = new Map<string, AbortController>();
  // channelId → set de userIds escribiendo.
  private readonly typingUsers = new Map<string, Set<string>>();
  private lastActiveChannelId: string | null = null;
  // Guard anti-solapamiento: @nestjs/schedule @Interval usa setInterval crudo (no
  // espera al async), a diferencia de discord.py @tasks.loop que es secuencial. Sin
  // esto, una iteración >60s (LLM) dispara una 2ª concurrente → doble entrega.
  private remindersRunning = false;
  private timeoutsRunning = false;
  private memQueueRunning = false;

  // Use-cases (hexagonal). En Nest llegan inyectados; los specs construyen esta
  // clase a mano con los 9 deps originales, así que hay fallback `new` con los
  // mismos deps. ponytail: quitar cuando los specs inyecten los use-cases.
  private readonly smartResponse: SmartResponseService;
  private readonly reminders: ReminderService;
  private readonly holidays: HolidayService;

  constructor(
    private readonly config: ConfigService,
    private readonly conversation: ConversationService,
    @Inject('AiBrain') private readonly brain: AiBrain,
    private readonly memory: MemoryService,
    private readonly stealthDm: StealthDmService,
    private readonly sleep: SleepService,
    private readonly music: MusicService,
    private readonly slashCommands: SlashCommandsService,
    private readonly parser: ActionParserService,
    @Optional() smartResponse?: SmartResponseService,
    @Optional() reminders?: ReminderService,
    @Optional() holidays?: HolidayService,
  ) {
    this.ready = new Promise((r) => (this.readyResolve = r));
    this.smartResponse =
      smartResponse ?? new SmartResponseService(config, conversation, brain, memory, stealthDm, music);
    this.smartResponse.attachGateway(this);
    this.reminders = reminders ?? new ReminderService(memory, brain, parser);
    this.holidays = holidays ?? new HolidayService(memory, brain);
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.destroy();
  }

  /** Expone el cliente (MusicService Phase 4 / scheduler Phase 6). */
  getClient(): Client | null {
    return this.client;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async start(): Promise<void> {
    const token = this.config.get<string>('bot_token');
    if (!token) {
      this.logger.warn('Sin bot_token en config. Discord no arranca.');
      this.readyResolve();
      return;
    }
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates, // sin este intent member.voice.channel es siempre null
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.bindEvents();
    try {
      await this.client.login(token);
    } catch (e) {
      this.logger.error(`Login Discord falló: ${(e as Error).message}`);
    }
  }

  /** WebUI POST /restart: destruye, recarga config (nuevas keys/modelos) y re-crea. */
  async restart(): Promise<void> {
    this.logger.log('Reiniciando cliente Discord...');
    await this.client?.destroy();
    this.client = null;
    this.pending.clear();
    this.typingUsers.clear();
    await this.brain.reloadConfig();
    this.ready = new Promise((r) => (this.readyResolve = r));
    await this.start();
  }

  private bindEvents(): void {
    const c = this.client!;
    c.on(Events.ClientReady, () => this.onReady());
    c.on(Events.TypingStart, (t) => {
      if (t.user && t.channel) this.onTypingStart(t.channel.id, t.user.id);
    });
    c.on(Events.MessageCreate, (m) => {
      this.onMessage(m).catch((e) => this.logger.error(`onMessage: ${(e as Error).message}`));
    });
    c.on(Events.InteractionCreate, (i) => {
      this.slashCommands.handle(i as any).catch((e) =>
        this.logger.error(`Interaction: ${(e as Error).message}`),
      );
    });
    c.on(Events.Error, (e) => this.logger.error(`Client error: ${e.message}`));
  }

  private async onReady(): Promise<void> {
    this.logger.log(`Conectado como ${this.client!.user!.tag} (ID: ${this.client!.user!.id})`);
    this.readyResolve();
    await this.slashCommands.register(this.client!);
    await this.updateBotStatus('idle');
  }

  // --- Estado visual (discord_client.py:211-235) ---
  async updateBotStatus(
    statusType: 'online' | 'idle' | 'dnd' = 'idle',
    activityText?: string,
  ): Promise<void> {
    if (!this.client?.isReady()) return;
    const status =
      statusType === 'online'
        ? PresenceUpdateStatus.Online
        : statusType === 'dnd'
          ? PresenceUpdateStatus.DoNotDisturb
          : PresenceUpdateStatus.Idle;
    const text =
      activityText ??
      (statusType === 'online'
        ? 'Conversando'
        : statusType === 'dnd'
          ? 'Ocupada / Error'
          : 'Esperando...');
    try {
      await this.client.user!.setPresence({
        status,
        activities: [{ name: text, type: ActivityType.Playing }],
      });
    } catch (e) {
      this.logger.warn(`Error actualizando status: ${(e as Error).message}`);
    }
  }

  // --- Typing → tracking + cancelación (discord_client.py:252-276) ---
  private onTypingStart(channelId: string, userId: string): void {
    if (!this.client?.user || userId === this.client.user.id) return;
    let set = this.typingUsers.get(channelId);
    if (!set) {
      set = new Set();
      this.typingUsers.set(channelId, set);
    }
    set.add(userId);
    // Alguien escribe → cancela cualquier generación pendiente en el canal.
    this.cancelChannel(channelId, `typing de ${userId}`);
    // Limpieza tras 10s (timeout de typing de Discord).
    setTimeout(() => {
      this.typingUsers.get(channelId)?.delete(userId);
    }, 10_000);
  }

  private cancelChannel(channelId: string, reason: string): void {
    for (const [k, controller] of this.pending) {
      if (k.startsWith(`${channelId}:`)) {
        controller.abort();
        this.pending.delete(k);
        this.logger.debug(`Cancelada tarea en ${channelId} (${reason})`);
      }
    }
  }

  // --- Entrada del pipeline (discord_client.py:306-401) ---
  private async onMessage(message: Message): Promise<void> {
    if (!message.author || message.author.bot) return;
    if (!message.channel) return;
    const channelId = message.channel.id;
    const userId = message.author.id;

    const allowed = this.config.get<string[]>('allowed_channels', []);
    const isDm = message.guild === null;
    // DMs pasan siempre; canales limitados al whitelist.
    if (!isDm && allowed.length > 0 && !allowed.includes(channelId)) return;

    // ponytail: !sync (sync de slash commands) se implementa en Phase 4 con los
    // comandos de música. Mientras tanto, ignorar para no gastar una llamada de IA.
    if (message.content.trim() === '!sync') return;

    this.logDmDebug(message, 'INPUT');

    // 1. Sesión + contexto del canal.
    const session = this.conversation.createOrUpdateSession(
      channelId,
      userId,
      message.author.displayName,
      message.content,
    );
    const wasActive = session.isActive;

    // 2. Trigger.
    const isMentioned =
      !!this.client?.user && message.mentions.has(this.client.user);
    const isReply = this.isReplyToBot(message);
    const isChannelEngaged = this.conversation
      .getChannelContext(channelId)
      .isBotEngaged();

    let shouldProcess = isMentioned || isReply || wasActive || isChannelEngaged || isDm;
    if (!shouldProcess) {
      const replyProb = this.config.get<number>('reply_probability', 0.01);
      if (Math.random() < replyProb) {
        shouldProcess = true;
        this.logger.debug(`Trigger por probabilidad (${replyProb}) para ${message.author.displayName}`);
      }
    }

    if (!shouldProcess) return;

    session.activate();
    void this.updateBotStatus('online');
    // Cancelar pendientes del canal (interrupción por nuevo mensaje).
    this.cancelChannel(channelId, `nuevo mensaje de ${message.author.displayName}`);
    // Guardar interacción del usuario YA (no perder contexto si se cancela).
    void this.saveInteraction(userId, message.author.displayName, message.content, false);

    // 3. Nueva tarea con debounce.
    const key = `${channelId}:${userId}`;
    const controller = new AbortController();
    this.pending.set(key, controller);
    void this.processWithDebounce(message, controller, key);
  }

  // Python (:354-355) usa message.reference.cached_message → None si no está en
  // caché. Fiel a eso: consultamos sólo el caché (sin fetch), para no disparar
  // is_reply en replies a mensajes viejos/no cacheados.
  private isReplyToBot(message: Message): boolean {
    if (!message.reference?.messageId || !this.client?.user) return false;
    const ref = message.channel?.messages.cache.get(message.reference.messageId);
    return !!ref && ref.author?.id === this.client.user.id;
  }

  // --- Debounce + espera de typing (discord_client.py:403-432) ---
  private async processWithDebounce(
    message: Message,
    controller: AbortController,
    key: string,
  ): Promise<void> {
    const channelId = message.channel!.id;
    try {
      await sleepMs(5000, controller.signal, ABORTED);
      const typing = () => this.typingUsers.get(channelId);
      // Si hay alguien escribiendo, esperar hasta 8s más.
      for (let i = 0; i < 8; i++) {
        if (!typing()?.size) break;
        await sleepMs(1000, controller.signal, ABORTED);
      }
      if (typing()?.size) {
        this.logger.debug(`Aún hay typing en ${channelId}. Cancelando.`);
        return;
      }
      // Se pasa la señal para que un nuevo mensaje/typing aborte el envío de una
      // respuesta obsoleta a mitad de vuelo (igual que asyncio.CancelledError).
      await this.processSmartResponse(message, controller.signal);
    } catch (e) {
      if (e !== ABORTED) this.logger.error(`processWithDebounce: ${(e as Error).message}`);
    } finally {
      if (this.pending.get(key) === controller) this.pending.delete(key);
    }
  }

  // --- Respuesta inteligente: use-case extraído a SmartResponseService (hexagonal) ---
  private async processSmartResponse(message: Message, signal: AbortSignal): Promise<void> {
    await this.smartResponse.process(message, signal);
  }

  // --- Envío de callback para timeouts del scheduler (discord_client.py:295-304) ---
  async sendMessageCallback(channelId: string, text: string): Promise<void> {
    try {
      // ponytail: cast — mismo motivo que processSmartResponse (unión de channel).
      const channel = this.client?.channels.cache.get(channelId) as any;
      if (channel?.isTextBased?.()) {
        await channel.sendTyping?.();
        await delay(1000 + Math.random() * 2000);
        await channel.send(text);
      }
    } catch (e) {
      this.logger.warn(`Error sendMessageCallback a ${channelId}: ${(e as Error).message}`);
    }
  }

  // --- Modo sueño wrapper (discord_client.py:826-839, :841-869) ---
  async enterSleepMode(channelId: string): Promise<void> {
    // ponytail: divergencia acknow. — Python envía directo (channel.send); aquí
    // reusamos sendMessageCallback (typing + delay 1-3s) para no duplicar lógica de
    // resolución de canal. El retardo cosmético en un mensaje de sistema es aceptable.
    // Volver a envío directo si la UX de "me voy a dormir" con typing molesta.
    await this.sleep.enterSleep((msg) => this.sendMessageCallback(channelId, msg));
  }

  /** Sonda de recuperación (discord_client.py:841-869). @Interval cada 60s; no-op si despierta. */
  @Interval(60000)
  async recoveryCheck(): Promise<void> {
    const { recovered } = await this.sleep.recoveryProbe(() => this.brain.testApiConnection());
    if (recovered && this.lastActiveChannelId) {
      await this.sendMessageCallback(this.lastActiveChannelId, this.sleep.randomRecovery());
    }
  }

  // --- Resumen de memoria (discord_client.py:871-882) ---
  async performMemorySummarization(userId: string): Promise<void> {
    try {
      const { summary, buffer } = await this.memory.getBufferAndSummary(userId);
      if (!buffer.length) return;
      // ponytail: sin model_name explícito — usa el ladder por defecto (gemma primary).
      // El fuente forzaba "gemma-3-27b-it"; lo dejamos configurable vía ladder.
      const newSummary = await this.brain.generateSummary(summary, buffer, userId);
      if (newSummary) {
        await this.memory.updateSummary(userId, newSummary, buffer);
        this.logger.log(`Resumen de memoria actualizado para ${userId}`);
      }
    } catch (e) {
      this.logger.warn(`Error en proceso de resumen: ${(e as Error).message}`);
    }
  }

  // --- Apagado controlado + resumen forzado (discord_client.py:884-897) ---
  async forceShutdownAndSummarize(): Promise<void> {
    this.logger.log('Apagado controlado con resumen forzado...');
    const pending = await this.memory.getUsersWithPendingBuffer();
    if (pending.length) {
      this.logger.log(`Resumiendo memorias para ${pending.length} usuarios...`);
      await Promise.all(pending.map((u) => this.performMemorySummarization(u)));
    }
    this.logger.log('Cerrando conexión con Discord...');
    await this.client?.destroy();
  }

  // --- Felicitación festiva (discord_client.py:962-991) — use-case en HolidayService. ---
  async celebrateHoliday(holidayName: string): Promise<void> {
    await this.holidays.celebrateHoliday(this.client!, holidayName, (ch, t) =>
      this.sendMessageCallback(ch, t),
    );
  }

  // --- Loops @Interval(60000) — puerto de los @tasks.loop(minutes=1) (Phase 6) ---
  // Cada uno guarda en client.isReady(): si Discord aún no conectó, reintenta al minuto.

  /** Timeouts de sesión + estado online/idle (discord_client.py:278-293). */
  @Interval(60000)
  async checkTimeoutsLoop(): Promise<void> {
    if (!this.client?.isReady() || this.timeoutsRunning) return;
    this.timeoutsRunning = true;
    try {
      await this.conversation.checkTimeouts((ch, text) => this.sendMessageCallback(ch, text));
      await this.updateBotStatus(this.conversation.hasActiveSession() ? 'online' : 'idle');
    } catch (e) {
      this.logger.warn(`Error en checkTimeoutsLoop: ${(e as Error).message}`);
    } finally {
      this.timeoutsRunning = false;
    }
  }

  /** Cola de memoria: permanente (>5min) + buffers stale → resumir (discord_client.py:899-916). */
  @Interval(60000)
  async processMemoryQueueLoop(): Promise<void> {
    if (this.memQueueRunning) return;
    this.memQueueRunning = true;
    try {
      const users = new Set<string>(await this.memory.processQueue());
      for (const u of await this.memory.checkStaleBuffers()) users.add(u);
      if (!users.size) return;
      this.logger.log(`Procesando resumen para ${users.size} usuarios (Batch/Stale)...`);
      for (const uid of users) void this.performMemorySummarization(uid);
    } catch (e) {
      this.logger.warn(`Error en processMemoryQueueLoop: ${(e as Error).message}`);
    } finally {
      this.memQueueRunning = false;
    }
  }

  /** Desconexión por canal de voz vacío tras 5min (music_manager.py:105-126). */
  @Interval(60000)
  async checkEmptyVoiceChannelsLoop(): Promise<void> {
    if (!this.client?.isReady()) return;
    try {
      await this.music.checkEmptyVoiceChannels(this.client);
    } catch (e) {
      this.logger.warn(`Error en checkEmptyVoiceChannelsLoop: ${(e as Error).message}`);
    }
  }

  /** Recordatorios embebidos en la auto-memoria — use-case en ReminderService. */
  @Interval(60000)
  async checkReminders(): Promise<void> {
    if (!this.client?.isReady() || this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      await this.reminders.checkReminders(this.client, this.lastActiveChannelId);
    } catch (e) {
      this.logger.warn(`Error en checkReminders: ${(e as Error).message}`);
    } finally {
      this.remindersRunning = false;
    }
  }

  /** Festividades en reloj GMT-4 — use-case en HolidayService. */
  @Interval(60000)
  async checkHolidays(): Promise<void> {
    if (!this.client?.isReady()) return;
    await this.holidays.checkHolidays(this.client, (ch, t) => this.sendMessageCallback(ch, t));
  }

  // --- Helpers (parte del gateway que consume SmartResponseService) ---

  // ponytail: los dos encolados de interacción (usuario en onMessage + bot en el
  // use-case) corren concurrentes y MemoryQueue es read-modify-write sobre un único
  // JSON → podían clobberse (se perdía 'Usuario: hola'; flake preexistente del spec
  // de pipeline, reproducible también con el código pre-refactor). Serializamos en
  // el gateway; fix de raíz = append atómico/lock en MemoryQueue (src/memory).
  private saveInteractionChain: Promise<void> = Promise.resolve();

  async saveInteraction(
    userId: string,
    userName: string,
    content: string,
    isBot: boolean,
  ): Promise<void> {
    const run = this.saveInteractionChain.then(() =>
      this.doSaveInteraction(userId, userName, content, isBot),
    );
    this.saveInteractionChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async doSaveInteraction(
    userId: string,
    userName: string,
    content: string,
    isBot: boolean,
  ): Promise<void> {
    // discord_client.py:803-824. Guardar nombre si no existe + encolar interacción.
    try {
      if (!isBot) {
        const mem = await this.memory.getMemory(userId);
        if (!mem.profile.name) {
          mem.profile.name = userName;
          await this.memory.saveMemory(userId, mem);
        }
      }
      const text = isBot
        ? `${this.config.get<string>('bot_name', 'Hakkurin')}: ${content}`
        : `Usuario: ${content}`;
      await this.memory.addToQueue(userId, text);
    } catch (e) {
      this.logger.warn(`Error guardando interacción: ${(e as Error).message}`);
    }
  }

  private logDmDebug(message: Message, phase: 'INPUT' | 'OUTPUT'): void {
    if (!this.config.get<boolean>('debug_dm', false)) return;
    if (!(message.channel instanceof DMChannel)) return;
    if (phase === 'INPUT') {
      this.logger.debug(`[DM INPUT] De: ${message.author.displayName} (ID: ${message.author.id})`);
      this.logger.debug(`[DM INPUT] Contenido: ${message.content}`);
    }
  }

  logDmOutput(message: Message, userName: string, userId: string, msgText: string): void {
    if (!this.config.get<boolean>('debug_dm', false)) return;
    if (!(message.channel instanceof DMChannel)) return;
    this.logger.debug(`[DM OUTPUT] Para: ${userName} (ID: ${userId})`);
    this.logger.debug(`[DM OUTPUT] Contenido: ${msgText}`);
  }

  /** El use-case de respuesta marca el último canal activo (lo usa recovery/reminders). */
  setLastActiveChannel(channelId: string): void {
    this.lastActiveChannelId = channelId;
  }

  /** @internal expuesto para que Phase 4 registre slash commands al estar listo. */
  isAdmin(message: Message): boolean {
    return !!message.member?.permissions.has(PermissionFlagsBits.Administrator);
  }
}
