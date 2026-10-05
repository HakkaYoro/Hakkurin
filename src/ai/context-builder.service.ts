import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../common/config.service';
import { MemoryService } from '../memory/memory.service';
import { formatGmt4, buildInteractionPrompt } from './ai-prompts';
import type { InteractionContext } from './ai-brain.interface';

// Presupuesto total del prompt (~800k chars) — antes en gemini.provider.ts.
const MAX_TOTAL_CHARS = 800_000;

export interface BuiltInteractionPrompt {
  prompt: string;
  imageData: Buffer | null;
  imageMime: string | null;
}

// Puerto hexagonal: el provider pide prompt+imagen sin conocer MemoryService.
export interface ContextBuilder {
  buildInteractionPrompt(ctx: InteractionContext): Promise<BuiltInteractionPrompt>;
}

// Ex-trasplante del cuerpo de analyzeInteraction (ai_handler.py:493-664): carga de perfiles,
// self-memory, presupuesto de historial, botAge y armado del prompt final.
@Injectable()
export class ContextBuilderService implements ContextBuilder {
  private readonly logger = new Logger(ContextBuilderService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly memory: MemoryService,
  ) {}

  async buildInteractionPrompt(ctx: InteractionContext): Promise<BuiltInteractionPrompt> {
    const systemPrompt = this.config.get<string>('system_prompt');
    const developerId = this.config.get<string>('developer_id', '321799812595056645');

    const currentTime = formatGmt4(new Date());

    // Edad del bot (nacimiento 2025-12-22 02:32 GMT-4 → 06:32 UTC).
    const birth = new Date(Date.UTC(2025, 11, 22, 6, 32));
    const ageMs = Date.now() - birth.getTime();
    const days = Math.floor(ageMs / 86_400_000);
    const remSec = Math.floor((ageMs % 86_400_000) / 1000);
    const hours = Math.floor(remSec / 3600);
    const minutes = Math.floor((remSec % 3600) / 60);
    const botAge = `${days} días, ${hours} horas y ${minutes} minutos`;

    // Perfiles solo de usuarios activos + el que habla.
    const usersToLoad = new Set<string>(ctx.activeUserIds ?? []);
    usersToLoad.add(String(ctx.userId));
    let profilesText = '';
    for (const uid of usersToLoad) {
      const summary = await this.memory.getMemorySummary(uid);
      if (summary.trim()) profilesText += `--- PERFIL DE USUARIO ID ${uid} ---\n${summary}\n`;
    }

    // Gestión de tokens (límite ~800k chars).
    const fixedContent = `${systemPrompt}\n${currentTime}\n${botAge}\n${profilesText}\nUsuario: ${ctx.userName}\n${ctx.userText}`;
    const fixedSize = fixedContent.length;
    let availableForHistory = MAX_TOTAL_CHARS - fixedSize - 5000;
    let historyText = ctx.contextMessages.join('\n');
    if (historyText.length > availableForHistory) {
      if (availableForHistory <= 0) {
        historyText = '';
        this.logger.warn('Prompt fijo excede límite de tokens. Historial eliminado.');
      } else {
        const excess = historyText.length - availableForHistory;
        historyText = historyText.slice(excess);
        const firstNl = historyText.indexOf('\n');
        if (firstNl !== -1) historyText = historyText.slice(firstNl + 1);
      }
    }

    const selfMem = await this.memory.getSelfMemory();
    const channelType = ctx.isDm ? 'DM (Mensaje Directo PRIVADO)' : 'Servidor (Canal PÚBLICO)';

    const prompt = buildInteractionPrompt({
      systemPrompt,
      developerId,
      currentTime,
      botAge,
      profilesText,
      historyText,
      selfMem,
      channelType,
      isSessionActive: ctx.isSessionActive,
      currentPlaying: ctx.currentPlaying,
      userName: ctx.userName,
      userId: ctx.userId,
      userText: ctx.userText,
      hasImage: !!ctx.imageData,
      urlContext: ctx.urlContext,
    });

    const imageData = ctx.imageData ? Buffer.from(ctx.imageData as Uint8Array) : null;
    return { prompt, imageData, imageMime: ctx.imageMimeType ?? null };
  }
}
