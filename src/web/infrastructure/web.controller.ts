// Secretos write-only (bot_token/gemini_keys/navidrome_password/openrouter_api_key/
// webui_token) jamás se hacen echo a la API; la única protección de entrada es el
// AuthGuard opt-in.
import { Body, Controller, Get, Header, HttpCode, Inject, Logger, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { join } from 'node:path';
import { ConfigService } from '../../common/config.service';
import { BOT_SELF_ID, MemoryService } from '../../memory/application/memory.service';
import { BotLifecycle } from '../application/ports/bot-lifecycle.port';
import type { MemberInfo } from '../application/ports/bot-lifecycle.port';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import {
  PROMPT_HAKKA,
  PROMPT_HOLIDAY,
  PROMPT_REMINDER,
  PROMPT_RULES,
  PROMPT_SELF_SUMMARY,
  PROMPT_TRANSLATE,
  PROMPT_USER_PROFILE,
} from '../../ai/application/ai-prompts';
import { StatsService } from '../../stats/stats.service';
import { AuthGuard } from './auth.guard';
import { LogTeeService } from './log-tee.service';

// El controller compila a dist/web/infrastructure/ → el SPA queda en dist/webui.
const WEBUI_DIR = join(__dirname, '..', '..', 'webui');

@Controller()
@UseGuards(AuthGuard)
export class WebController {
  private readonly logger = new Logger(WebController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly memory: MemoryService,
    @Inject(BotLifecycle) private readonly discord: BotLifecycle,
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly logTee: LogTeeService,
    private readonly stats: StatsService,
  ) {}

  @Get()
  root(@Res() res: Response): void {
    res.sendFile('index.html', { root: WEBUI_DIR }, (err) => {
      if (err && !res.headersSent) res.status(503).send('WebUI sin construir — ejecuta `npm run build`.');
    });
  }

  @Get('api/config')
  apiConfig() {
    const c = this.config.getAll();
    return {
      bot_name: c.bot_name ?? '',
      bot_contact: c.bot_contact ?? '',
      system_prompt: c.system_prompt ?? '',
      reply_probability: c.reply_probability ?? 0.125,
      developer_id: c.developer_id ?? '',
      allowed_channels: (c.allowed_channels ?? []).join('\n'),
      ai_provider: c.ai_provider ?? 'gemini',
      openrouter_chat_model: c.openrouter_chat_model ?? '',
      openrouter_memory_model: c.openrouter_memory_model ?? '',
      openrouter_reasoning_effort: c.openrouter_reasoning_effort ?? 'default',
      max_history_messages: c.max_history_messages ?? 20,
      deafen_move_enabled: !!c.deafen_move_enabled,
      deafen_move_channel_id: c.deafen_move_channel_id ?? '',
      deafen_move_minutes: c.deafen_move_minutes ?? 3,
      navidrome_base_url: c.navidrome_base_url ?? '',
      navidrome_external_url: c.navidrome_external_url ?? '',
      navidrome_username: c.navidrome_username ?? '',
      ytdl_sidecar_url: c.ytdl_sidecar_url ?? '',
      // Prompts efectivos: el default vive en código, config sólo lo overridea.
      prompt_hakka: c.prompt_hakka || PROMPT_HAKKA,
      prompt_rules: c.prompt_rules || PROMPT_RULES,
      prompt_holiday: c.prompt_holiday || PROMPT_HOLIDAY,
      prompt_self_summary: c.prompt_self_summary || PROMPT_SELF_SUMMARY,
      prompt_user_profile: c.prompt_user_profile || PROMPT_USER_PROFILE,
      prompt_translate: c.prompt_translate || PROMPT_TRANSLATE,
      prompt_reminder: c.prompt_reminder || PROMPT_REMINDER,
      has_bot_token: !!c.bot_token,
      has_navidrome_password: !!c.navidrome_password,
      has_openrouter_key: !!c.openrouter_api_key,
      has_webui_token: !!c.webui_token,
      gemini_keys_count: (c.gemini_keys ?? []).length,
    };
  }

  // Sólo flags/contadores: jamás valores de secretos.
  @Get('api/status')
  status() {
    const c = this.config.getAll();
    return {
      bot: this.discord.getStatus(),
      provider: c.ai_provider ?? 'gemini',
      chatModel: c.openrouter_chat_model || '',
      memoryModel: c.openrouter_memory_model || '',
      reasoningEffort: c.openrouter_reasoning_effort ?? 'default',
      geminiKeysCount: (c.gemini_keys ?? []).length,
    };
  }

  @Get('api/stats')
  async statsData(@Query('hours') hoursParam?: string) {
    const allowed = [1, 24, 168, 720];
    const hours = allowed.includes(Number(hoursParam)) ? Number(hoursParam) : 24;
    const r = this.stats.rankings(hours);
    const cache = new Map<string, MemberInfo>();
    // Resolución en secuencia: mismo userId en varios rankings → una sola llamada.
    const ids = new Set<string>(r.users.map((u) => u.id));
    for (const c of r.commands) if (c.topUserId) ids.add(c.topUserId);
    for (const id of ids) await this.resolveMember(id, cache);
    const users = r.users.map((u) => ({ ...cache.get(u.id)!, messages: u.messages }));
    const commands = r.commands.map((c) => ({
      command: c.command,
      count: c.count,
      topUser: c.topUserId ? { ...cache.get(c.topUserId)!, count: c.topUserCount } : null,
    }));
    return { ...r, users, commands };
  }

  @Post('api/stats/reset')
  @HttpCode(200)
  async resetStats(): Promise<{ ok: true }> {
    await this.stats.reset();
    return { ok: true };
  }

  private async resolveMember(userId: string, cache: Map<string, MemberInfo>): Promise<MemberInfo> {
    let m = cache.get(userId);
    if (!m) {
      m = (await this.discord.getMemberInfo(userId)) ?? { id: userId, name: userId, avatarUrl: null };
      cache.set(userId, m);
    }
    return m;
  }

  @Post('api/update_config')
  @HttpCode(200)
  async updateConfig(@Body() body: any): Promise<{ ok: true }> {
    for (const key of ['bot_name', 'bot_contact', 'system_prompt', 'developer_id']) {
      if (body[key] != null) await this.config.set(key, String(body[key]));
    }
    if (typeof body.allowed_channels === 'string') {
      await this.config.set(
        'allowed_channels',
        body.allowed_channels.split('\n').map((s: string) => s.trim()).filter(Boolean),
      );
    }
    await this.config.set('deafen_move_enabled', Boolean(body.deafen_move_enabled));
    if (body.ai_provider === 'gemini' || body.ai_provider === 'openrouter') {
      await this.config.set('ai_provider', body.ai_provider);
    }
    if (['default', 'none', 'low', 'medium', 'high'].includes(body.openrouter_reasoning_effort)) {
      await this.config.set('openrouter_reasoning_effort', body.openrouter_reasoning_effort);
    }
    for (const key of [
      'navidrome_base_url', 'navidrome_external_url', 'navidrome_username', 'ytdl_sidecar_url',
      'deafen_move_channel_id',
      // Prompts: vacío = mantener el actual (el default vive en código).
      'prompt_hakka', 'prompt_rules', 'prompt_holiday', 'prompt_self_summary',
      'prompt_user_profile', 'prompt_translate', 'prompt_reminder',
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
    return { ok: true };
  }

  // Dump seguro por diseño: el código jamás loguea secrets/stream_urls.
  @Get('logs')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="hakkurin.log"')
  logs(): string {
    return this.logTee.text();
  }

  @Post('api/restart')
  @HttpCode(200)
  restart(): { ok: true } {
    // .catch(): reloadConfig/start pueden lanzar; un unhandledRejection mata el proceso.
    void this.discord
      .forceShutdownAndSummarize()
      .then(() => this.discord.restart())
      .catch((e) => this.logger.error(`Error en reinicio: ${(e as Error).message}`));
    return { ok: true };
  }

  @Get('api/memories')
  async memories() {
    const rows = await this.memory.listMemories();
    const memories = await Promise.all(
      rows.map(async (m) => {
        if (m.is_self) return { ...m, name: 'Memoria interna', avatarUrl: null };
        const info = await this.discord.getMemberInfo(m.user_id);
        return { ...m, name: info?.name ?? m.user_id, avatarUrl: info?.avatarUrl ?? null };
      }),
    );
    return { memories };
  }

  @Get('api/memories/:user_id')
  async memoryView(@Param('user_id') userId: string) {
    const content =
      userId === BOT_SELF_ID
        ? await this.memory.getSelfMemory()
        : (await this.memory.getMemorySummary(userId)) || 'Sin resumen generado aún.';
    return { user_id: userId, content };
  }

  @Post('api/memories/delete_all')
  @HttpCode(200)
  async deleteAllMemories(): Promise<{ ok: true }> {
    await this.memory.deleteAllMemories();
    return { ok: true };
  }

  @Post('api/memories/:user_id/delete')
  @HttpCode(200)
  async deleteMemory(@Param('user_id') userId: string): Promise<{ ok: true }> {
    await this.memory.deleteMemory(userId);
    return { ok: true };
  }
}
