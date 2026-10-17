// Secretos write-only (bot_token/gemini_keys/navidrome_password/openrouter_api_key/
// webui_token) jamás se hacen echo al DOM ni a /status; la única protección de
// entrada es el AuthGuard opt-in.
import { Body, Controller, Get, Header, Inject, Logger, Param, Post, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '../../common/config.service';
import { BOT_SELF_ID, MemoryService } from '../../memory/application/memory.service';
import { BotLifecycle } from '../application/ports/bot-lifecycle.port';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { StatsService } from '../../stats/stats.service';
import { ViewService } from './view.service';
import { AuthGuard } from './auth.guard';
import { LogTeeService } from './log-tee.service';

@Controller()
@UseGuards(AuthGuard)
export class WebController {
  private readonly logger = new Logger(WebController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly memory: MemoryService,
    @Inject(BotLifecycle) private readonly discord: BotLifecycle,
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly view: ViewService,
    private readonly logTee: LogTeeService,
    private readonly stats: StatsService,
  ) {}

  @Get()
  root(): string {
    const c = this.config.getAll();
    return this.view.render('index.html', {
      bot_name: c.bot_name,
      system_prompt: c.system_prompt,
      reply_probability: c.reply_probability,
      developer_id: c.developer_id,
      allowed_channels: (c.allowed_channels ?? []).join('\n'),
      ai_provider: c.ai_provider ?? 'gemini',
      openrouter_chat_model: c.openrouter_chat_model ?? '',
      openrouter_memory_model: c.openrouter_memory_model ?? '',
      max_history_messages: c.max_history_messages ?? 20,
      deafen_move_enabled: !!c.deafen_move_enabled,
      deafen_move_channel_id: c.deafen_move_channel_id ?? '',
      deafen_move_minutes: c.deafen_move_minutes ?? 3,
      navidrome_base_url: c.navidrome_base_url ?? '',
      navidrome_external_url: c.navidrome_external_url ?? '',
      navidrome_username: c.navidrome_username ?? '',
      ytdl_sidecar_url: c.ytdl_sidecar_url ?? '',
      has_bot_token: !!c.bot_token,
      has_navidrome_password: !!c.navidrome_password,
      has_openrouter_key: !!c.openrouter_api_key,
      has_webui_token: !!c.webui_token,
      gemini_keys_count: (c.gemini_keys ?? []).length,
      openrouter_configured: !!(c.openrouter_api_key && c.openrouter_chat_model),
      bot: this.discord.getStatus(),
      stats: this.stats.snapshot(),
    });
  }

  // Sólo flags/contadores: jamás valores de secretos.
  @Get('status')
  status() {
    const c = this.config.getAll();
    return {
      bot: this.discord.getStatus(),
      provider: c.ai_provider ?? 'gemini',
      chatModel: c.openrouter_chat_model || '',
      memoryModel: c.openrouter_memory_model || '',
      geminiKeysCount: (c.gemini_keys ?? []).length,
      openrouterConfigured: !!(c.openrouter_api_key && c.openrouter_chat_model),
    };
  }

  @Post('update_config')
  @Redirect('/?saved=true', 303)
  async updateConfig(@Body() body: any): Promise<void> {
    for (const key of ['bot_name', 'system_prompt', 'developer_id']) {
      if (body[key] != null) await this.config.set(key, String(body[key]));
    }
    if (typeof body.allowed_channels === 'string') {
      await this.config.set(
        'allowed_channels',
        body.allowed_channels.split('\n').map((s: string) => s.trim()).filter(Boolean),
      );
    }
    // checkbox: el formulario sólo envía 'on' si está marcado; ausente → false.
    await this.config.set('deafen_move_enabled', Boolean(body.deafen_move_enabled));
    for (const key of [
      'navidrome_base_url', 'navidrome_external_url', 'navidrome_username', 'ytdl_sidecar_url',
      'deafen_move_channel_id',
      'bot_token', 'navidrome_password', 'webui_token', // write-only secrets
    ]) {
      if (typeof body[key] === 'string' && body[key].trim()) await this.config.set(key, body[key].trim());
    }
    for (const key of ['reply_probability', 'max_history_messages', 'deafen_move_minutes']) {
      const n = parseFloat(body[key]);
      if (!isNaN(n)) await this.config.set(key, n);
    }
    let reload = false;
    if (typeof body.gemini_keys === 'string' && body.gemini_keys.trim()) {
      const keys = body.gemini_keys.split('\n').map((k: string) => k.trim()).filter(Boolean);
      await this.config.set('gemini_keys', keys);
      reload = true;
    }
    for (const key of ['openrouter_chat_model', 'openrouter_memory_model']) {
      if (typeof body[key] === 'string' && body[key].trim()) {
        await this.config.set(key, body[key].trim());
        reload = true;
      }
    }
    if (typeof body.openrouter_api_key === 'string' && body.openrouter_api_key.trim()) {
      await this.config.set('openrouter_api_key', body.openrouter_api_key.trim());
      reload = true;
    }
    // ai_provider NO requiere reload: el RoutingBrain lo lee en caliente por llamada.
    if (reload) {
      try {
        await this.brain.reloadConfig();
      } catch (e) {
        this.logger.warn(`reload AI tras update_config: ${(e as Error).message}`);
      }
    }
  }

  // Dump seguro por diseño: el código jamás loguea secrets/stream_urls.
  @Get('logs')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="hakkurin.log"')
  logs(): string {
    return this.logTee.text();
  }

  @Post('restart')
  @Redirect('/?restarted=true', 303)
  restart(): void {
    // .catch(): reloadConfig/start pueden lanzar; un unhandledRejection mata el proceso.
    void this.discord
      .forceShutdownAndSummarize()
      .then(() => this.discord.restart())
      .catch((e) => this.logger.error(`Error en reinicio: ${(e as Error).message}`));
  }

  @Get('memories')
  async memories(): Promise<string> {
    return this.view.render('memories.html', { memories: await this.memory.listMemories() });
  }

  @Get('memories/:user_id')
  async memoryView(@Param('user_id') userId: string): Promise<string> {
    const content =
      userId === BOT_SELF_ID
        ? await this.memory.getSelfMemory()
        : (await this.memory.getMemorySummary(userId)) || 'Sin resumen generado aún.';
    return this.view.render('memory_view.html', { user_id: userId, content });
  }

  @Post('memories/delete_all')
  @Redirect('/memories?deleted=all', 303)
  async deleteAllMemories(): Promise<void> {
    await this.memory.deleteAllMemories();
  }

  @Post('memories/:user_id/delete')
  @Redirect('/memories?deleted=single', 303)
  async deleteMemory(@Param('user_id') userId: string): Promise<void> {
    await this.memory.deleteMemory(userId);
  }
}
