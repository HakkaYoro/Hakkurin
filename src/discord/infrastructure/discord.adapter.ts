import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ActivityType,
  Client,
  DiscordAPIError,
  DMChannel,
  Events,
  GatewayIntentBits,
  Partials,
  PresenceUpdateStatus,
  type Message,
} from 'discord.js';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { ConfigService } from '../../common/config.service';
import { MemoryService } from '../../memory/application/memory.service';
import { ConversationService } from '../../conversation/application/conversation.service';
import { StealthDmService } from '../application/stealth-dm.service';
import { SleepService } from '../application/sleep.service';
import { SlashCommandsService } from './slash-commands.service';
import { MusicService } from '../../music/application/music.service';
import { ActionParserService } from '../application/action-parser.service';
import { delay, sleepMs } from '../../common/util';
import { ABORTED, SmartResponseService } from '../application/smart-response.service';
import { ReminderService } from '../application/reminder.service';
import { HolidayService } from '../application/holiday.service';
import { IncomingMessage } from '../domain/incoming-message';
import { BotStatePort } from '../domain/ports/bot-state.port';
import { MessageTransportPort, SendOptions } from '../domain/ports/message-transport.port';
import { BotLifecycle } from '../../web/application/ports/bot-lifecycle.port';

@Injectable()
export class DiscordAdapter implements OnModuleInit, OnModuleDestroy, MessageTransportPort, BotStatePort, BotLifecycle {
  private readonly logger = new Logger(DiscordAdapter.name);
  private client: Client | null = null;

  private readonly pending = new Map<string, AbortController>();
  private readonly typingUsers = new Map<string, Set<string>>();
  private lastActiveChannelId: string | null = null;
  // @Interval usa setInterval crudo (no espera al async): una iteración >60s (LLM)
  // dispararía una 2ª concurrente → doble entrega.
  private remindersRunning = false;
  private timeoutsRunning = false;
  private memQueueRunning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly conversation: ConversationService,
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly memory: MemoryService,
    private readonly stealthDm: StealthDmService,
    private readonly sleep: SleepService,
    private readonly music: MusicService,
    private readonly slashCommands: SlashCommandsService,
    private readonly parser: ActionParserService,
    private readonly smartResponse: SmartResponseService,
    private readonly reminders: ReminderService,
    private readonly holidays: HolidayService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.destroy();
  }

  async start(): Promise<void> {
    const token = this.config.get<string>('bot_token');
    if (!token) {
      this.logger.warn('Sin bot_token en config. Discord no arranca.');
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

  async restart(): Promise<void> {
    this.logger.log('Reiniciando cliente Discord...');
    await this.client?.destroy();
    this.client = null;
    this.pending.clear();
    this.typingUsers.clear();
    await this.brain.reloadConfig();
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
    await this.slashCommands.register(this.client!);
    await this.updateBotStatus('idle');
  }

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

  private onTypingStart(channelId: string, userId: string): void {
    if (!this.client?.user || userId === this.client.user.id) return;
    let set = this.typingUsers.get(channelId);
    if (!set) {
      set = new Set();
      this.typingUsers.set(channelId, set);
    }
    set.add(userId);
    // Typing activo → cancela la generación pendiente del canal.
    this.cancelChannel(channelId, `typing de ${userId}`);
    // 10s = timeout de typing de Discord.
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

  private async onMessage(message: Message): Promise<void> {
    if (!message.author || message.author.bot) return;
    if (!message.channel) return;
    const channelId = message.channel.id;
    const userId = message.author.id;

    const allowed = this.config.get<string[]>('allowed_channels', []);
    const isDm = message.guild === null;
    if (!isDm && allowed.length > 0 && !allowed.includes(channelId)) return;

    // ponytail: !sync aún no existe como comando de sincronización; ignorarlo
    // evita gastar una llamada de IA.
    if (message.content.trim() === '!sync') return;

    this.logDmDebug(message);

    const session = this.conversation.createOrUpdateSession(
      channelId,
      userId,
      message.author.displayName,
      message.content,
    );
    const wasActive = session.isActive;

    const isMentioned =
      !!this.client?.user && message.mentions.has(this.client.user);
    const isReply = this.isReplyToBot(message);
    const isChannelEngaged = this.conversation
      .getChannelContext(channelId)
      .isBotEngaged();

    let shouldProcess = isMentioned || isReply || wasActive || isChannelEngaged || isDm;
    if (!shouldProcess) {
      const replyProb = this.config.get<number>('reply_probability', 0.125);
      if (Math.random() < replyProb) {
        shouldProcess = true;
        this.logger.debug(`Trigger por probabilidad (${replyProb}) para ${message.author.displayName}`);
      }
    }

    if (!shouldProcess) return;

    session.activate();
    void this.updateBotStatus('online');
    this.cancelChannel(channelId, `nuevo mensaje de ${message.author.displayName}`);
    // Guardar la interacción YA: no perder contexto si se cancela.
    void this.saveInteraction(userId, message.author.displayName, message.content);

    const key = `${channelId}:${userId}`;
    const controller = new AbortController();
    this.pending.set(key, controller);
    void this.processWithDebounce(message, controller, key);
  }

  // Sólo caché (sin fetch): replies a mensajes no cacheados no cuentan como is_reply.
  private isReplyToBot(message: Message): boolean {
    if (!message.reference?.messageId || !this.client?.user) return false;
    const ref = message.channel?.messages.cache.get(message.reference.messageId);
    return !!ref && ref.author?.id === this.client.user.id;
  }

  private async processWithDebounce(
    message: Message,
    controller: AbortController,
    key: string,
  ): Promise<void> {
    const channelId = message.channel!.id;
    try {
      await sleepMs(5000, controller.signal, ABORTED);
      const typing = () => this.typingUsers.get(channelId);
      for (let i = 0; i < 8; i++) {
        if (!typing()?.size) break;
        await sleepMs(1000, controller.signal, ABORTED);
      }
      if (typing()?.size) {
        this.logger.debug(`Aún hay typing en ${channelId}. Cancelando.`);
        return;
      }
      // La señal también aborta el envío de una respuesta obsoleta a mitad de vuelo.
      await this.processSmartResponse(message, controller.signal);
    } catch (e) {
      if (e !== ABORTED) this.logger.error(`processWithDebounce: ${(e as Error).message}`);
    } finally {
      if (this.pending.get(key) === controller) this.pending.delete(key);
    }
  }

  private async processSmartResponse(message: Message, signal: AbortSignal): Promise<void> {
    await this.smartResponse.process(this.toIncomingMessage(message), signal);
  }

  private toIncomingMessage(message: Message): IncomingMessage {
    return {
      id: message.id,
      channelId: message.channel.id,
      guildId: message.guildId ?? null,
      authorId: message.author.id,
      authorName: message.author.displayName,
      content: message.content,
      mentionIds: [...message.mentions.users.values()].filter((u) => !u.bot).map((u) => u.id),
      attachments: [...message.attachments.values()].map((a) => ({
        name: a.name ?? '',
        url: a.url,
        contentType: a.contentType,
      })),
    };
  }

  // ponytail: cast — la unión de canales de discord.js incluye PartialGroupDMChannel
  // (sin send); un canal presente en caché con isTextBased() siempre envía.
  private resolveTextChannel(channelId: string): any {
    const channel = this.client?.channels.cache.get(channelId) as any;
    return channel?.isTextBased?.() ? channel : null;
  }

  isChannelSendable(channelId: string): boolean {
    return !!this.resolveTextChannel(channelId);
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = this.resolveTextChannel(channelId);
    if (!channel) return;
    try {
      await channel.sendTyping?.();
    } catch (e) {
      this.logger.warn(`Error sendTyping a ${channelId}: ${(e as Error).message}`);
    }
  }

  async sendToChannel(
    channelId: string,
    content: string,
    opts?: SendOptions,
  ): Promise<boolean> {
    const channel = this.resolveTextChannel(channelId);
    if (!channel) return false;
    try {
      if (opts?.typing) {
        await channel.sendTyping?.();
        await delay(1000 + Math.random() * 2000);
      }
      if (opts?.replyTo) {
        try {
          await channel.send({ content, messageReference: opts.replyTo });
          return true;
        } catch (e) {
          // 10008/404 = referenciado borrado: reenviar sin referencia.
          if (!(e instanceof DiscordAPIError && (e.code === 10008 || e.status === 404))) {
            this.logger.warn(`Error enviando a ${channelId}: ${(e as Error).message}`);
            return false;
          }
        }
      }
      await channel.send(content);
      return true;
    } catch (e) {
      if (e instanceof DiscordAPIError && e.status >= 500) {
        this.logger.warn(`Error 5xx Discord enviando: ${e.message}. Ignorando.`);
      } else {
        this.logger.warn(`Error enviando a ${channelId}: ${(e as Error).message}`);
      }
      return false;
    }
  }

  async sendMessageCallback(channelId: string, text: string): Promise<void> {
    await this.sendToChannel(channelId, text, { typing: true });
  }

  async sendDm(userId: string, content: string, guildId?: string | null): Promise<boolean> {
    if (!this.client) return false;
    const id = userId.trim();
    try {
      let target: any = null;
      if (guildId) {
        const guild = this.client.guilds.cache.get(guildId);
        if (guild) {
          try {
            target = await guild.members.fetch(id);
          } catch {
            target = null;
          }
        }
      }
      if (!target) target = await this.client.users.fetch(id);
      if (target) {
        await target.send(content);
        return true;
      }
      return false;
    } catch (e) {
      if (e instanceof DiscordAPIError && (e.code === 50007 || e.status === 403)) {
        this.logger.warn(`[MD OCULTO] 403 Forbidden enviando a ${id}: DMs cerrados.`);
      } else {
        this.logger.warn(`[MD OCULTO] Error enviando a ${id}: ${(e as Error).message}`);
      }
      return false;
    }
  }

  async fetchImage(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url);
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  async fetchUsername(userId: string): Promise<string | null> {
    try {
      return (await this.client?.users.fetch(userId))?.username ?? null;
    } catch {
      return null;
    }
  }

  logDmOutput(channelId: string, userName: string, userId: string, msgText: string): void {
    if (!this.config.get<boolean>('debug_dm', false)) return;
    const channel = this.client?.channels.cache.get(channelId);
    if (!(channel instanceof DMChannel)) return;
    this.logger.debug(`[DM OUTPUT] Para: ${userName} (ID: ${userId})`);
    this.logger.debug(`[DM OUTPUT] Contenido: ${msgText}`);
  }

  getBotUserId(): string | null {
    return this.client?.user?.id ?? null;
  }

  @Interval(60000)
  async recoveryCheck(): Promise<void> {
    const { recovered } = await this.sleep.recoveryProbe(() => this.brain.testApiConnection());
    if (recovered && this.lastActiveChannelId) {
      await this.sendMessageCallback(this.lastActiveChannelId, this.sleep.randomRecovery());
    }
  }

  async performMemorySummarization(userId: string): Promise<void> {
    try {
      const { summary, buffer } = await this.memory.getBufferAndSummary(userId);
      if (!buffer.length) return;
      // ponytail: sin model_name explícito — usa el ladder por defecto (gemma primary).
      // Upgrade path: modelo configurable por llamada.
      const newSummary = await this.brain.generateSummary(summary, buffer, userId);
      if (newSummary) {
        await this.memory.updateSummary(userId, newSummary, buffer);
        this.logger.log(`Resumen de memoria actualizado para ${userId}`);
      }
    } catch (e) {
      this.logger.warn(`Error en proceso de resumen: ${(e as Error).message}`);
    }
  }

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

  // Si aún no hay cliente listo, el intento del loop es no-op y reintenta al minuto.
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

  @Interval(60000)
  async checkEmptyVoiceChannelsLoop(): Promise<void> {
    if (!this.client?.isReady()) return;
    try {
      await this.music.checkEmptyVoiceChannels(this.client);
    } catch (e) {
      this.logger.warn(`Error en checkEmptyVoiceChannelsLoop: ${(e as Error).message}`);
    }
  }

  @Interval(60000)
  async checkReminders(): Promise<void> {
    if (!this.client?.isReady() || this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      await this.reminders.checkReminders(this.lastActiveChannelId);
    } catch (e) {
      this.logger.warn(`Error en checkReminders: ${(e as Error).message}`);
    } finally {
      this.remindersRunning = false;
    }
  }

  @Interval(60000)
  async checkHolidays(): Promise<void> {
    if (!this.client?.isReady()) return;
    await this.holidays.checkHolidays();
  }

  async saveInteraction(userId: string, userName: string, content: string): Promise<void> {
    try {
      const mem = await this.memory.getMemory(userId);
      if (!mem.profile.name) {
        mem.profile.name = userName;
        await this.memory.saveMemory(userId, mem);
      }
      await this.memory.addToQueue(userId, `Usuario: ${content}`);
    } catch (e) {
      this.logger.warn(`Error guardando interacción: ${(e as Error).message}`);
    }
  }

  private logDmDebug(message: Message): void {
    if (!this.config.get<boolean>('debug_dm', false)) return;
    if (!(message.channel instanceof DMChannel)) return;
    this.logger.debug(`[DM INPUT] De: ${message.author.displayName} (ID: ${message.author.id})`);
    this.logger.debug(`[DM INPUT] Contenido: ${message.content}`);
  }

  setLastActiveChannel(channelId: string): void {
    this.lastActiveChannelId = channelId;
  }
}
