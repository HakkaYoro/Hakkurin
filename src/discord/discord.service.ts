// Puerto de bot/discord_client.py (gateway + pipeline de mensajes).
// discord.js directo (sin necord): el pipeline necesita control imperativo del
// Client (cancelación por typing, debounce abortable) y el POST /restart del WebUI
// requiere destruir+recrear el cliente. Los 6 slash commands se registran en
// onReady en Phase 4. Los loops @tasks (timeouts/holidays/queue/recovery/reminders)
// son Phase 6 y llaman a los métodos públicos de aquí.
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ActivityType,
  Client,
  DMChannel,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  type Message,
} from 'discord.js';
import type { AiBrain } from '../ai/ai-brain.interface';
import { ConfigService } from '../common/config.service';
import { BOT_SELF_ID, MemoryService } from '../memory/memory.service';
import { ConversationService } from '../conversation/conversation.service';
import { StealthDmService } from './stealth-dm.service';
import { SleepService } from './sleep.service';
import { SlashCommandsService } from './slash-commands.service';
import { MusicService } from '../music/music.service';
import { ActionParserService, type ScheduledAction } from '../scheduler/action-parser.service';
import { getUrlContext } from './url-context';
import { normalizeResponseContent } from './response-normalize';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

const ABORTED = Symbol('aborted');
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

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
  // dedupe de recordatorios ejecutados (actionKey → epoch sec). TTL 1h. Puerto de discord_client.py:123-128.
  private readonly executedActionsCache = new Map<string, number>();
  // Guard anti-solapamiento: @nestjs/schedule @Interval usa setInterval crudo (no
  // espera al async), a diferencia de discord.py @tasks.loop que es secuencial. Sin
  // esto, una iteración >60s (LLM) dispara una 2ª concurrente → doble entrega.
  private remindersRunning = false;
  private timeoutsRunning = false;
  private memQueueRunning = false;

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
  ) {
    this.ready = new Promise((r) => (this.readyResolve = r));
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
      await this.sleepMs(5000, controller.signal);
      const typing = () => this.typingUsers.get(channelId);
      // Si hay alguien escribiendo, esperar hasta 8s más.
      for (let i = 0; i < 8; i++) {
        if (!typing()?.size) break;
        await this.sleepMs(1000, controller.signal);
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

  // --- Respuesta inteligente (discord_client.py:434-777) ---
  private async processSmartResponse(message: Message, signal: AbortSignal): Promise<void> {
    const channel = message.channel!;
    const channelId = channel.id;
    const userId = message.author.id;
    const userName = message.author.displayName;
    const userText = message.content;
    const isDm = message.guild === null;

    // Contexto global del canal.
    const channelHistory = this.conversation.getChannelContext(channelId).getFormattedHistory();
    const activeUserIds = this.conversation.getActiveUsers(channelId, 20);
    for (const m of message.mentions.users.values()) {
      if (!m.bot) activeUserIds.push(m.id);
    }

    // Imágenes: guardar adjuntos + recuperar recientes del contexto.
    const channelCtx = this.conversation.getChannelContext(channelId);
    if (message.attachments.size > 0) {
      for (const att of message.attachments.values()) {
        if (!IMAGE_EXT.test(att.name)) continue;
        try {
          const res = await fetch(att.url);
          const buf = Buffer.from(await res.arrayBuffer());
          channelCtx.addImage(buf, att.contentType || 'image/jpeg');
        } catch (e) {
          this.logger.warn(`Error descargando imagen ${att.name}: ${(e as Error).message}`);
        }
      }
    }
    const recentImages = channelCtx.getRecentImages(60);
    let imageData: Buffer | null = recentImages.length ? recentImages[recentImages.length - 1].data : null;
    let imageMime: string | null = recentImages.length ? recentImages[recentImages.length - 1].mime : null;

    // Estado del reproductor. ponytail: Phase 4 inyecta MusicService; por ahora null.
    const currentPlaying = this.getNowPlaying(message);

    // Enriquecimiento por URL (oEmbed/HTML). Puede aportar thumbnail como imagen.
    const urlCtx = await getUrlContext(userText);
    let urlContext = urlCtx.text;
    if (!imageData && urlCtx.thumbnailData) {
      imageData = urlCtx.thumbnailData;
      imageMime = urlCtx.thumbnailMime;
    }

    const analysis = await this.brain.analyzeInteraction({
      userText,
      userId,
      userName,
      contextMessages: channelHistory,
      isSessionActive: true,
      imageData,
      imageMimeType: imageMime,
      activeUserIds,
      isDm,
      currentPlaying,
      urlContext,
    });
    this.logger.debug(`Análisis para ${userName}: ${JSON.stringify(analysis)}`);
    // Si llegaron mensajes/typing nuevos mientras la IA pensaba, no enviar respuesta obsoleta.
    if (signal.aborted) return;

    const intent = analysis.intent;
    const responseContent = normalizeResponseContent(analysis.response_content);
    const isTalkingToMe = analysis.is_talking_to_me;
    const replyToId = analysis.reply_to_message_id;
    const pingUsers = analysis.ping_users ?? [];
    const isChannelEngaged = channelCtx.isBotEngaged();

    if (intent === 'ignore') {
      this.logger.debug(`Ignorando mensaje de ${userName} (intent: ignore)`);
      return;
    }

    if (intent === 'error') {
      this.logger.warn('Error crítico en análisis. Activando modo sueño de emergencia.');
      await this.updateBotStatus('dnd', 'Error Crítico');
      await this.enterSleepMode(channelId);
      return;
    }

    if (!['reply', 'complain', 'new_topic'].includes(intent) || !responseContent.length) return;

    // Referencia de mensaje (reply).
    let reference: { messageId: string; channelId: string } | null = null;
    if (replyToId) {
      reference = { messageId: replyToId, channelId };
    } else if (isTalkingToMe && !isChannelEngaged) {
      reference = { messageId: message.id, channelId };
    }

    const pingText = pingUsers.map((u) => `<@${u}> `).join('');
    let fullResponseText = '';

    // Pausa inicial de "lectura" con indicador de typing (discord_client.py:661-663).
    await (channel as any).sendTyping();
    await this.sleepMs(500 + Math.random() * 1000, signal);
    if (signal.aborted) return;

    for (let i = 0; i < responseContent.length; i++) {
      let msgText = responseContent[i];
      if (!msgText) continue;

      // DM invisible: extraer + limpiar del texto público.
      const dms = this.stealthDm.extractDms(msgText);
      msgText = this.stealthDm.stripDms(msgText);
      if (!msgText) continue;

      if (i === 0 && pingText) msgText = pingText + msgText;

      const typingTime = Math.min(Math.max(msgText.length * 0.08, 0.5), 4.0);
      try {
        // ponytail: cast — la unión de tipos de message.channel de discord.js
        // incluye PartialGroupDMChannel (sin send); un canal con mensaje real siempre envía.
        await (channel as any).sendTyping();
        await this.sleepMs(typingTime * 1000, signal);
        if (signal.aborted) return;
        try {
          if (i === 0 && reference) {
            await (channel as any).send({ content: msgText, messageReference: reference });
          } else {
            await (channel as any).send(msgText);
          }
        } catch (e2) {
          // discord_client.py:724-725: si el mensaje referenciado se borró (10008/404),
          // reenviar sin referencia para no perder el texto.
          if (e2 instanceof DiscordAPIError && (e2.code === 10008 || e2.status === 404)) {
            await (channel as any).send(msgText);
          } else {
            throw e2;
          }
        }
      } catch (e) {
        if (e instanceof DiscordAPIError && e.status >= 500) {
          this.logger.warn(`Error 5xx Discord enviando: ${e.message}. Ignorando.`);
        } else {
          this.logger.warn(`Error enviando respuesta: ${(e as Error).message}`);
        }
      }

      this.logDmOutput(message, userName, userId, msgText);
      fullResponseText += msgText + ' ';
      // Pausa entre mensajes (abortable: si cancelan, cortamos el multi-mensaje).
      await this.sleepMs(200 + Math.random() * 300, signal);
    }

    // DMs diferidos (~3s tras la respuesta pública).
    const allDms = responseContent.flatMap((t) => this.stealthDm.extractDms(t));
    if (allDms.length && this.client) this.stealthDm.scheduleDelayedDms(message, allDms, this.client);

    // Registrar la respuesta en el contexto global + auto-memoria.
    const botName = this.config.get<string>('bot_name', 'Hakkurin');
    channelCtx.addMessage(botName, this.client!.user!.id, fullResponseText.trim());
    channelCtx.updateBotActivity();
    this.lastActiveChannelId = channelId;

    const shouldSummarizeSelf = await this.memory.logSelfAction(fullResponseText.trim());
    if (shouldSummarizeSelf) void this.performMemorySummarization(BOT_SELF_ID);

    void this.memory.updateLastChannel(userId, channelId);
    void this.saveInteraction(userId, userName, fullResponseText.trim(), true);
  }

  /** Canción actual para contexto del LLM (discord_client.py:484-491). */
  private getNowPlaying(message: Message): string | null {
    if (!message.guildId) return null;
    return this.music.getNowPlaying(message.guildId);
  }

  // --- Envío de callback para timeouts del scheduler (discord_client.py:295-304) ---
  async sendMessageCallback(channelId: string, text: string): Promise<void> {
    try {
      // ponytail: cast — mismo motivo que processSmartResponse (unión de channel).
      const channel = this.client?.channels.cache.get(channelId) as any;
      if (channel?.isTextBased?.()) {
        await channel.sendTyping?.();
        await this.delay(1000 + Math.random() * 2000);
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

  // --- Felicitación festiva (discord_client.py:962-991) — Phase 6 la dispara. ---
  async celebrateHoliday(holidayName: string): Promise<void> {
    const users = await this.memory.getAllUsersData();
    this.logger.log(`Enviando felicitaciones de ${holidayName} a ${users.length} usuarios...`);
    for (const u of users) {
      if (!u.last_channel_id) continue;
      const channelId = String(u.last_channel_id);
      // Paridad discord_client.py:975-976: get_channel + if not channel: continue ANTES
      // de generar el greeting. Evita gastar LLM en usuarios con canal inaccesible.
      const channel = this.client?.channels.cache.get(channelId) as any;
      if (!channel?.isTextBased?.()) continue;
      try {
        const msg = await this.brain.generateHolidayGreeting(u.summary ?? '', holidayName);
        await this.sendMessageCallback(channelId, `<@${u.user_id}> ${msg}`);
        await this.delay(2000 + Math.random() * 3000); // evitar rate limit masivo
      } catch (e) {
        this.logger.warn(`Error felicitando a ${u.user_id}: ${(e as Error).message}`);
      }
    }
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

  /** Recordatorios embebidos en la auto-memoria (discord_client.py:104-205). */
  @Interval(60000)
  async checkReminders(): Promise<void> {
    if (!this.client?.isReady() || this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      const selfMemoryText = await this.memory.getSelfMemory();
      if (!selfMemoryText) return;

      const actions = this.parser.parseScheduledActions(selfMemoryText);
      const due = this.parser.checkDueActions(actions);
      if (!due.length) return;

      const nowSec = Date.now() / 1000;
      for (const [k, ts] of this.executedActionsCache) {
        if (nowSec - ts > 3600) this.executedActionsCache.delete(k);
      }

      const executed: ScheduledAction[] = [];
      for (const action of due) {
        const key = this.parser.buildActionKey(action);
        if (this.executedActionsCache.has(key)) continue;

        const actionDesc = action.action_description;
        const targetUserId = action.target_user_id;

        // Resolver canal objetivo (memoria del target → último canal activo → cualquier usuario).
        let channelId: string | null = null;
        if (targetUserId && /^\d+$/.test(targetUserId)) {
          const targetMem = await this.memory.getMemory(targetUserId);
          if (targetMem.last_channel_id != null) channelId = String(targetMem.last_channel_id);
        }
        if (!channelId) channelId = this.lastActiveChannelId;
        if (!channelId) {
          for (const u of await this.memory.getAllUsersData()) {
            if (u.last_channel_id) {
              channelId = String(u.last_channel_id);
              break;
            }
          }
        }
        if (!channelId) continue;

        // Paridad discord_client.py:159-161: el canal debe estar en caché (get_channel).
        // Si no lo está (borrado / DM no cacheado tras restart), se reintenta al minuto
        // SIN consumir el recordatorio. isTextBased descarta canales sin .send.
        const channel = this.client.channels.cache.get(channelId) as any;
        if (!channel?.isTextBased?.()) continue;

        let ctxId = BOT_SELF_ID;
        let userName = 'Sistema';
        let ping = '';
        if (targetUserId && /^\d+$/.test(targetUserId)) {
          ctxId = targetUserId;
          ping = `<@${targetUserId}> `;
          try {
            const u = await this.client.users.fetch(targetUserId);
            if (u) userName = u.username;
          } catch {
            userName = 'Usuario';
          }
        }

        const prompt =
          `[SISTEMA]: EJECUCIÓN DE RECORDATORIO AUTOMÁTICO.\n` +
          `ACCIÓN: ${actionDesc}\n` +
          `INSTRUCCIÓN: Genera el mensaje para cumplir este compromiso ahora mismo.\n` +
          `NOTA: Debes mencionar al usuario ${ping.trim()} si corresponde. Usa tu memoria con él para ser personal y natural.`;
        let response = await this.brain.generateResponse(prompt, ctxId, userName);
        if (typeof response !== 'string' || !response.trim()) {
          response = `${ping}recordatorio: ${actionDesc}`.trim();
        }

        // Paridad :191-193: marcar ejecutado SÓLO si el envío real tuvo éxito. Si
        // send lanza, la acción no se cachea ni se borra → reintenta. (sendMessageCallback
        // traga errores, así que aquí enviamos directo y vigilamos el resultado.)
        let sent = false;
        try {
          await channel.send(response);
          sent = true;
        } catch (e) {
          this.logger.warn(`Error enviando recordatorio a ${channelId}: ${(e as Error).message}`);
        }
        if (!sent) continue;

        this.executedActionsCache.set(key, nowSec);
        executed.push(action);
        await this.memory.logSelfAction(`EJECUTÉ RECORDATORIO: ${actionDesc} para ${userName}`);
      }

      if (executed.length) {
        const cleaned = this.parser.removeExecutedActionsFromMemory(selfMemoryText, executed);
        if (cleaned !== selfMemoryText) {
          await this.memory.updateSummary(BOT_SELF_ID, cleaned, []);
        }
      }
    } catch (e) {
      this.logger.warn(`Error en checkReminders: ${(e as Error).message}`);
    } finally {
      this.remindersRunning = false;
    }
  }

  /** Festividades en reloj GMT-4 (discord_client.py:918-960). */
  @Interval(60000)
  async checkHolidays(): Promise<void> {
    if (!this.client?.isReady()) return;
    // Wall clock GMT-4: desplazar epoch -4h y leer campos UTC (paridad con datetime.now(tz(-4))).
    const now = new Date(Date.now() - 4 * 3600 * 1000);
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const year = String(now.getUTCFullYear());

    const HOLIDAY_FILE = 'data/holidays.json';
    let data: Record<string, boolean> = {};
    try {
      if (existsSync(HOLIDAY_FILE)) data = JSON.parse(await readFile(HOLIDAY_FILE, 'utf8'));
    } catch {
      data = {};
    }

    // (mes, día, hora, minuto, key, nombre)
    const events: ReadonlyArray<readonly [number, number, number, number, string, string]> = [
      [12, 25, 0, 1, 'xmas', 'Navidad'],
      [1, 1, 0, 0, 'newyear', 'Año Nuevo'],
    ];

    for (const [m, d, h, min, key, name] of events) {
      if (month !== m || day !== d || hour !== h || minute !== min) continue;
      const eventKey = `${key}_${year}`;
      if (data[eventKey]) continue;
      data[eventKey] = true;
      try {
        await mkdir(dirname(HOLIDAY_FILE), { recursive: true });
        await writeFile(HOLIDAY_FILE, JSON.stringify(data));
        this.logger.log(`¡Es ${name}! Iniciando celebración global...`);
        await this.celebrateHoliday(name);
      } catch (e) {
        this.logger.warn(`Error celebrando ${name}: ${(e as Error).message}`);
      }
    }
  }

  // --- Helpers ---

  private async saveInteraction(
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

  private logDmOutput(message: Message, userName: string, userId: string, msgText: string): void {
    if (!this.config.get<boolean>('debug_dm', false)) return;
    if (!(message.channel instanceof DMChannel)) return;
    this.logger.debug(`[DM OUTPUT] Para: ${userName} (ID: ${userId})`);
    this.logger.debug(`[DM OUTPUT] Contenido: ${msgText}`);
  }

  private sleepMs(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(ABORTED);
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(ABORTED);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** @internal expuesto para que Phase 4 registre slash commands al estar listo. */
  isAdmin(message: Message): boolean {
    return !!message.member?.permissions.has(PermissionFlagsBits.Administrator);
  }
}
