import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '../../common/config.service';
import { InteractionAnsweredEvent, INTERACTION_ANSWERED } from '../../ai/domain/events/interaction-answered.event';
import { MemoryService } from './memory.service';

/** Consumidor de InteractionAnswered: encola la respuesta del bot para su
 *  promoción a memoria permanente (la dedupe-window de la cola evita ecos). */
@Injectable()
export class MemoryEventsListener implements OnModuleInit {
  private readonly logger = new Logger(MemoryEventsListener.name);

  constructor(
    private readonly events: EventEmitter2,
    private readonly memory: MemoryService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.listen(this.events);
  }

  listen(events: EventEmitter2): void {
    events.on(INTERACTION_ANSWERED, (e: InteractionAnsweredEvent) => {
      void this.onInteractionAnswered(e);
    });
  }

  private async onInteractionAnswered(e: InteractionAnsweredEvent): Promise<void> {
    try {
      const botName = this.config.get<string>('bot_name', 'Hakkurin');
      await this.memory.addToQueue(e.userId, `${botName}: ${e.replyText}`);
    } catch (err) {
      this.logger.warn(`Error guardando interacción: ${(err as Error).message}`);
    }
  }
}
