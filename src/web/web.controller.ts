// Puerto de web/app.py. Dashboard + config + memories + restart, server-rendered.
// Fix de seguridad vs el original: secretos write-only (no se hace echo de
// bot_token/gemini_keys/navidrome_password al DOM) y auth guard opt-in.
import { Body, Controller, Get, Inject, Logger, Param, Post, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '../common/config.service';
import { BOT_SELF_ID, MemoryService } from '../memory/memory.service';
import { BOT_LIFECYCLE, type BotLifecycle } from './bot-lifecycle.port';
import type { AiBrain } from '../ai/ai-brain.interface';
import { ViewService } from './view.service';
import { AuthGuard } from './auth.guard';

@Controller()
@UseGuards(AuthGuard)
export class WebController {
  private readonly logger = new Logger(WebController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly memory: MemoryService,
    @Inject(BOT_LIFECYCLE) private readonly discord: BotLifecycle,
    @Inject('AiBrain') private readonly brain: AiBrain,
    private readonly view: ViewService,
  ) {}

  @Get()
  root(): string {
    const c = this.config.getAll();
    return this.view.render('index.html', {
      bot_name: c.bot_name,
      system_prompt: c.system_prompt,
      reply_probability: c.reply_probability,
      developer_id: c.developer_id,
      navidrome_base_url: c.navidrome_base_url ?? '',
      navidrome_external_url: c.navidrome_external_url ?? '',
      navidrome_username: c.navidrome_username ?? '',
      ytdl_sidecar_url: c.ytdl_sidecar_url ?? '',
      has_bot_token: !!c.bot_token,
      has_navidrome_password: !!c.navidrome_password,
      gemini_keys_count: (c.gemini_keys ?? []).length,
    });
  }

  @Post('update_config')
  @Redirect('/?saved=true', 303)
  async updateConfig(@Body() body: any): Promise<void> {
    // No-secret: siempre setear (vienen con valor desde el form).
    if (body.bot_name != null) await this.config.set('bot_name', String(body.bot_name));
    if (body.system_prompt != null) await this.config.set('system_prompt', String(body.system_prompt));
    if (body.reply_probability != null) {
      const v = parseFloat(body.reply_probability);
      if (!isNaN(v)) await this.config.set('reply_probability', v);
    }
    if (body.developer_id != null) await this.config.set('developer_id', String(body.developer_id));
    await this.setIf(body, 'navidrome_base_url');
    await this.setIf(body, 'navidrome_external_url');
    await this.setIf(body, 'navidrome_username');
    await this.setIf(body, 'ytdl_sidecar_url');
    // Write-only secrets: solo sobrescribir si el campo viene rellenado.
    await this.setIf(body, 'bot_token');
    await this.setIf(body, 'navidrome_password');
    let keysChanged = false;
    if (typeof body.gemini_keys === 'string' && body.gemini_keys.trim()) {
      const keys = body.gemini_keys.split('\n').map((k: string) => k.trim()).filter(Boolean);
      await this.config.set('gemini_keys', keys);
      keysChanged = true;
    }
    // Si cambiaron las keys, recargar el brain en caliente (sin need de Restart):
    // el provider cachea las keys en this.keys y sólo reloadConfig() las repuebla.
    if (keysChanged) {
      try {
        await this.brain.reloadConfig();
      } catch (e) {
        this.logger.warn(`reload Gemini tras update_config: ${(e as Error).message}`);
      }
    }
  }

  @Post('restart')
  @Redirect('/?restarted=true', 303)
  restart(): void {
    // En background: resumir pendientes + destruir, recargar config, re-crear cliente.
    // .catch() para evitar unhandledRejection (reloadConfig/start podrían lanzar).
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

  private async setIf(body: any, key: string): Promise<void> {
    const val = body[key];
    if (typeof val === 'string' && val.trim()) await this.config.set(key, val.trim());
  }
}
