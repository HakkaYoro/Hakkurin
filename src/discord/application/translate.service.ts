import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { PROMPT_TRANSLATE, fill } from '../../ai/application/ai-prompts';
import { ConfigService } from '../../common/config.service';
import { StatsService } from '../../stats/stats.service';

const MAX_INPUT = 4000;
const MAX_OUTPUT = 1800;
const DEDUPE_CAP = 500;

@Injectable()
export class TranslateService {
  private readonly logger = new Logger(TranslateService.name);
  // ponytail: Set con vaciado al llenarse; upgrade path: LRU con TTL.
  private readonly seen = new Set<string>();

  constructor(
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly config: ConfigService,
    private readonly stats: StatsService,
  ) {}

  shouldTranslate(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    if (this.seen.size >= DEDUPE_CAP) this.seen.clear();
    this.seen.add(messageId);
    return true;
  }

  async translate(text: string): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_INPUT) return null;
    const out = await this.brain.generateResponse(fill(this.config.get('prompt_translate') || PROMPT_TRANSLATE, { texto: trimmed }));
    if (!out) {
      this.logger.warn('Traducción: la IA no devolvió respuesta.');
      return null;
    }
    this.stats.bumpAiCall('translate');
    return out.trim().slice(0, MAX_OUTPUT);
  }
}
