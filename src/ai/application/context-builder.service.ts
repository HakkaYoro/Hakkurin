import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../common/config.service';
import { MemoryService } from '../../memory/application/memory.service';
import { formatGmt4, buildInteractionPrompt } from './ai-prompts';
import type { InteractionContext } from '../domain/ports/ai-brain.port';

// Presupuesto total del prompt: ~16k tokens a ~4 chars/token, dentro del
// presupuesto Gemma por minuto de 15000 tokens, con margen para la salida.
const MAX_TOTAL_CHARS = 60_000;

export interface BuiltInteractionPrompt {
  prompt: string;
  imageData: Buffer | null;
  imageMime: string | null;
}

export interface ContextBuilder {
  buildInteractionPrompt(ctx: InteractionContext): Promise<BuiltInteractionPrompt>;
}

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

    // Menciones en el texto (<@id>) siempre cargan perfil completo y cola cruda.
    const mentioned = [...ctx.userText.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
    // Ahorro de tokens: máximo 8 perfiles de usuarios activos; el hablante y los
    // mencionados entran siempre.
    const usersToLoad = new Set<string>([...(ctx.activeUserIds ?? []).slice(0, 8), ...mentioned]);
    usersToLoad.add(String(ctx.userId));
    let profilesText = '';
    // La cola cruda ("MEMORIA RECIENTE") sólo viaja para el hablante y los
    // mencionados; el resto de activos carga sólo su resumen.
    const withRawQueue = new Set<string>([String(ctx.userId), ...mentioned]);
    for (const uid of usersToLoad) {
      const text = withRawQueue.has(uid)
        ? await this.memory.getMemorySummary(uid)
        : (await this.memory.getMemory(uid)).summary;
      if (text?.trim()) profilesText += `--- PERFIL DE USUARIO ID ${uid} ---\n${text}\n`;
    }

    const fixedContent = `${systemPrompt}\n${currentTime}\n${botAge}\n${profilesText}\nUsuario: ${ctx.userName}\n${ctx.userText}`;
    const fixedSize = fixedContent.length;
    let availableForHistory = MAX_TOTAL_CHARS - fixedSize - 5000;
    // Recorte por mensajes ANTES del presupuesto de caracteres.
    const maxHistory = this.config.get<number>('max_history_messages', 20);
    let historyText = ctx.contextMessages.slice(-maxHistory).join('\n');
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
      currentPlaying: ctx.currentPlaying,
      userName: ctx.userName,
      userId: ctx.userId,
      userText: ctx.userText,
      hasImage: !!ctx.imageData,
      imageNote: ctx.imageNote ?? null,
      urlContext: ctx.urlContext,
    });

    const imageData = ctx.imageData ? Buffer.from(ctx.imageData as Uint8Array) : null;
    return { prompt, imageData, imageMime: ctx.imageMimeType ?? null };
  }
}
