// Use-case de respuesta inteligente (puerto de discord_client.py:434-777), extraído
// de DiscordService (hexagonal): el gateway (gateway events, debounce, presencia)
// queda en DiscordService y aquí vive el caso de uso completo — contexto de
// conversación, imágenes, enriquecimiento por URL, análisis LLM, routing de intents,
// stealth DMs, typing simulado, envío con reintentos y auto-memoria.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DiscordAPIError, type Client, type Message } from 'discord.js';
import type { AiBrain } from '../ai/ai-brain.interface';
import { ConfigService } from '../common/config.service';
import { sleepMs } from '../common/util';
import { BOT_SELF_ID, MemoryService } from '../memory/memory.service';
import { ConversationService } from '../conversation/conversation.service';
import { MusicService } from '../music/music.service';
import { StealthDmService } from './stealth-dm.service';
import { getUrlContext } from './url-context';
import { normalizeResponseContent } from './response-normalize';

/** Símbolo con el que sleepMs rechaza al abortar; DiscordService lo compara en su catch. */
export const ABORTED = Symbol('aborted');

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * Capacidades del gateway que el use-case necesita y viven en DiscordService
 * (presencia, modo sueño, cliente, persistencia de interacción). ponytail: en vez
 * de DI circular (DiscordService↔use-case), DiscordService se adjunta a sí mismo
 * vía attachGateway(). Upgrade path: partir DiscordService en presencia+envío.
 */
export interface SmartResponseGateway {
  getClient(): Client | null;
  updateBotStatus(statusType?: 'online' | 'idle' | 'dnd', activityText?: string): Promise<void>;
  enterSleepMode(channelId: string): Promise<void>;
  performMemorySummarization(userId: string): Promise<void>;
  saveInteraction(userId: string, userName: string, content: string, isBot: boolean): Promise<void>;
  logDmOutput(message: Message, userName: string, userId: string, msgText: string): void;
  setLastActiveChannel(channelId: string): void;
}

@Injectable()
export class SmartResponseService {
  private readonly logger = new Logger(SmartResponseService.name);
  private gateway: SmartResponseGateway | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly conversation: ConversationService,
    @Inject('AiBrain') private readonly brain: AiBrain,
    private readonly memory: MemoryService,
    private readonly stealthDm: StealthDmService,
    private readonly music: MusicService,
  ) {}

  /** @internal lo cablea DiscordService en su constructor (evita DI circular). */
  attachGateway(gateway: SmartResponseGateway): void {
    this.gateway = gateway;
  }

  private get gw(): SmartResponseGateway {
    if (!this.gateway) throw new Error('SmartResponseService sin gateway (falta attachGateway)');
    return this.gateway;
  }

  async process(message: Message, signal: AbortSignal): Promise<void> {
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

    // Estado del reproductor.
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
      await this.gw.updateBotStatus('dnd', 'Error Crítico');
      await this.gw.enterSleepMode(channelId);
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
    await sleepMs(500 + Math.random() * 1000, signal, ABORTED);
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
        await sleepMs(typingTime * 1000, signal, ABORTED);
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

      this.gw.logDmOutput(message, userName, userId, msgText);
      fullResponseText += msgText + ' ';
      // Pausa entre mensajes (abortable: si cancelan, cortamos el multi-mensaje).
      await sleepMs(200 + Math.random() * 300, signal, ABORTED);
    }

    // DMs diferidos (~3s tras la respuesta pública).
    const client = this.gw.getClient();
    const allDms = responseContent.flatMap((t) => this.stealthDm.extractDms(t));
    if (allDms.length && client) this.stealthDm.scheduleDelayedDms(message, allDms, client);

    // Registrar la respuesta en el contexto global + auto-memoria.
    const botName = this.config.get<string>('bot_name', 'Hakkurin');
    channelCtx.addMessage(botName, client!.user!.id, fullResponseText.trim());
    channelCtx.updateBotActivity();
    this.gw.setLastActiveChannel(channelId);

    const shouldSummarizeSelf = await this.memory.logSelfAction(fullResponseText.trim());
    if (shouldSummarizeSelf) void this.gw.performMemorySummarization(BOT_SELF_ID);

    void this.memory.updateLastChannel(userId, channelId);
    void this.gw.saveInteraction(userId, userName, fullResponseText.trim(), true);
  }

  /** Canción actual para contexto del LLM (discord_client.py:484-491). */
  private getNowPlaying(message: Message): string | null {
    if (!message.guildId) return null;
    return this.music.getNowPlaying(message.guildId);
  }
}
