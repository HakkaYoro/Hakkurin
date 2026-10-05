import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { InteractionAnsweredEvent, INTERACTION_ANSWERED } from '../../ai/domain/events/interaction-answered.event';
import { ConfigService } from '../../common/config.service';
import { sleepMs } from '../../common/util';
import { BOT_SELF_ID, MemoryService } from '../../memory/application/memory.service';
import { ConversationService } from '../../conversation/application/conversation.service';
import { MusicService } from '../../music/application/music.service';
import { StealthDmService } from './stealth-dm.service';
import { SleepService } from './sleep.service';
import { IncomingMessage } from '../domain/incoming-message';
import { BotStatePort } from '../domain/ports/bot-state.port';
import { MessageTransportPort } from '../domain/ports/message-transport.port';
import { UrlEnricherPort } from '../domain/ports/url-enricher.port';
import { normalizeResponseContent } from '../../ai/infrastructure/mappers/response-normalize';

/** Símbolo con el que sleepMs rechaza al abortar; DiscordAdapter lo compara en su catch. */
export const ABORTED = Symbol('aborted');

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

@Injectable()
export class SmartResponseService {
  private readonly logger = new Logger(SmartResponseService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly conversation: ConversationService,
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly memory: MemoryService,
    @Inject(forwardRef(() => MessageTransportPort))
    private readonly transport: MessageTransportPort,
    @Inject(forwardRef(() => BotStatePort)) private readonly state: BotStatePort,
    @Inject(UrlEnricherPort) private readonly urlEnricher: UrlEnricherPort,
    private readonly stealthDm: StealthDmService,
    private readonly sleep: SleepService,
    private readonly music: MusicService,
    private readonly events: EventEmitter2,
  ) {}

  async process(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    const channelId = message.channelId;
    const userId = message.authorId;
    const userName = message.authorName;
    const userText = message.content;
    const isDm = message.guildId === null;

    const channelHistory = this.conversation.getChannelContext(channelId).getFormattedHistory();
    const activeUserIds = this.conversation.getActiveUsers(channelId, 20);
    for (const id of message.mentionIds) activeUserIds.push(id);

    const channelCtx = this.conversation.getChannelContext(channelId);
    for (const att of message.attachments) {
      if (!IMAGE_EXT.test(att.name)) continue;
      const data = await this.transport.fetchImage(att.url);
      if (data) channelCtx.addImage(data, att.contentType || 'image/jpeg');
      else this.logger.warn(`Error descargando imagen ${att.name}`);
    }
    const recentImages = channelCtx.getRecentImages(60);
    let imageData: Buffer | null = recentImages.length ? recentImages[recentImages.length - 1].data : null;
    let imageMime: string | null = recentImages.length ? recentImages[recentImages.length - 1].mime : null;

    const currentPlaying = this.getNowPlaying(message);

    const urlCtx = await this.urlEnricher.enrich(userText);
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
    // Llegaron mensajes/typing nuevos mientras la IA pensaba: no enviar respuesta obsoleta.
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
      await this.state.updateBotStatus('dnd', 'Error Crítico');
      await this.sleep.enterSleep(channelId);
      return;
    }

    if (!['reply', 'complain', 'new_topic'].includes(intent) || !responseContent.length) return;

    let reference: { messageId: string; channelId: string } | null = null;
    if (replyToId) {
      reference = { messageId: replyToId, channelId };
    } else if (isTalkingToMe && !isChannelEngaged) {
      reference = { messageId: message.id, channelId };
    }

    const pingText = pingUsers.map((u) => `<@${u}> `).join('');
    let fullResponseText = '';

    await this.transport.sendTyping(channelId);
    await sleepMs(500 + Math.random() * 1000, signal, ABORTED);

    for (let i = 0; i < responseContent.length; i++) {
      let msgText = responseContent[i];
      if (!msgText) continue;

      msgText = this.stealthDm.stripDms(msgText);
      if (!msgText) continue;

      if (i === 0 && pingText) msgText = pingText + msgText;

      const typingTime = Math.min(Math.max(msgText.length * 0.08, 0.5), 4.0);
      await this.transport.sendTyping(channelId);
      await sleepMs(typingTime * 1000, signal, ABORTED);
      await this.transport.sendToChannel(
        channelId,
        msgText,
        i === 0 && reference ? { replyTo: reference } : undefined,
      );

      this.transport.logDmOutput(channelId, userName, userId, msgText);
      fullResponseText += msgText + ' ';
      await sleepMs(200 + Math.random() * 300, signal, ABORTED);
    }

    const allDms = responseContent.flatMap((t) => this.stealthDm.extractDms(t));
    if (allDms.length) this.stealthDm.scheduleDelayedDms(message.guildId, allDms);

    const botName = this.config.get<string>('bot_name', 'Hakkurin');
    channelCtx.addMessage(botName, this.transport.getBotUserId() ?? '', fullResponseText.trim());
    channelCtx.updateBotActivity();
    this.state.setLastActiveChannel(channelId);

    const shouldSummarizeSelf = await this.memory.logSelfAction(fullResponseText.trim());
    if (shouldSummarizeSelf) void this.state.performMemorySummarization(BOT_SELF_ID);

    void this.memory.updateLastChannel(userId, channelId);
    this.events.emit(INTERACTION_ANSWERED, new InteractionAnsweredEvent(userId, channelId, fullResponseText.trim()));
  }

  private getNowPlaying(message: IncomingMessage): string | null {
    if (!message.guildId) return null;
    return this.music.getNowPlaying(message.guildId);
  }
}
