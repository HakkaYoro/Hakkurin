import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../common/config.service';
import { StatsService } from '../../stats/stats.service';
import type { AiBrain, AnalysisResult, InteractionContext } from '../domain/ports/ai-brain.port';
import { GeminiAdapter } from '../infrastructure/adapters/gemini.adapter';
import { OpenRouterAdapter } from '../infrastructure/adapters/openrouter.adapter';

// Hot-swap: el proveedor se lee EN CALIENTE en cada llamada (WebUI cambia
// ai_provider sin reiniciar el proceso).
@Injectable()
export class RoutingBrain implements AiBrain {
  constructor(
    private readonly gemini: GeminiAdapter,
    private readonly openrouter: OpenRouterAdapter,
    private readonly config: ConfigService,
    private readonly stats: StatsService,
  ) {}

  private provider(): AiBrain {
    return this.config.get<string>('ai_provider', 'gemini') === 'openrouter' ? this.openrouter : this.gemini;
  }

  async analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult> {
    this.stats.bumpAiCall('analyze');
    return this.provider().analyzeInteraction(ctx);
  }

  async generateResponse(
    prompt: string,
    userContextId?: string,
    userName?: string,
  ): Promise<string | null> {
    this.stats.bumpAiCall('response');
    return this.provider().generateResponse(prompt, userContextId, userName);
  }

  async generateSummary(
    currentSummary: string,
    recentInteractions: string[],
    userId: string,
    modelName?: string,
  ): Promise<string | null> {
    this.stats.bumpAiCall('summary');
    return this.provider().generateSummary(currentSummary, recentInteractions, userId, modelName);
  }

  async generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string> {
    this.stats.bumpAiCall('holiday');
    return this.provider().generateHolidayGreeting(userSummary, holidayName);
  }

  async testApiConnection(): Promise<boolean> {
    return this.provider().testApiConnection();
  }

  async reloadConfig(): Promise<void> {
    await this.gemini.reloadConfig();
    await this.openrouter.reloadConfig();
  }
}
