import { Injectable, OnModuleInit } from '@nestjs/common';
import { EncryptorPort, MemoryQueuePort, MemoryRepositoryPort } from '../domain/ports/memory.ports';
import { UserMemory, UserMemoryAggregate } from '../domain/entities/user-memory.aggregate';

const STALE_BUFFER_SECONDS = 1800;

export const BOT_SELF_ID = 'hakkurin_internal_self';

@Injectable()
export class MemoryService implements OnModuleInit {
  constructor(
    private readonly crypto: EncryptorPort,
    private readonly repo: MemoryRepositoryPort,
    private readonly queue: MemoryQueuePort,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repo.init();
    await this.queue.init();
  }

  async getMemory(user_id: string): Promise<UserMemory> {
    return UserMemoryAggregate.fromRaw(await this.repo.getMemory(user_id)).raw;
  }

  async saveMemory(user_id: string, memoryData: any): Promise<void> {
    await this.repo.saveMemory(user_id, UserMemoryAggregate.fromRaw(memoryData).raw);
  }

  async addInteraction(user_id: string, interactionText: any): Promise<boolean> {
    if (interactionText == null) return false;
    const text = String(interactionText).trim();
    if (!text) return false;

    const agg = UserMemoryAggregate.fromRaw(await this.repo.getMemory(user_id), user_id);
    const shouldSummarize = agg.appendInteraction(text);
    await this.repo.saveMemory(user_id, agg.raw);
    return shouldSummarize;
  }

  async checkStaleBuffers(): Promise<string[]> {
    const users: string[] = [];
    const now = Date.now() / 1000;
    for (const user_id of await this.repo.listUserIds()) {
      const mem = await this.getMemory(user_id);
      const lastSum = mem.last_summary_time || 0;
      if (mem.history_buffer.length > 0 && now - lastSum > STALE_BUFFER_SECONDS) users.push(user_id);
    }
    return users;
  }

  async getSelfMemory(): Promise<string> {
    const mem = await this.getMemory(BOT_SELF_ID);
    return mem.summary || 'Sin memoria interna previa.';
  }

  async logSelfAction(actionText: string): Promise<boolean> {
    return this.addInteraction(BOT_SELF_ID, `[YO DIJE/HICE]: ${actionText}`);
  }

  async getBufferAndSummary(user_id: string): Promise<{ summary: string; buffer: string[] }> {
    const mem = await this.getMemory(user_id);
    return { summary: mem.summary || '', buffer: [...mem.history_buffer] };
  }

  async updateSummary(
    user_id: string,
    newSummary: string | null,
    processedInteractions?: string[] | null,
  ): Promise<void> {
    const agg = UserMemoryAggregate.fromRaw(await this.repo.getMemory(user_id), user_id);
    agg.applySummary(newSummary, processedInteractions);
    await this.repo.saveMemory(user_id, agg.raw);
    await this.repo.saveSummaryPlaintext(user_id, agg.raw.summary);
  }

  async getUsersWithPendingBuffer(): Promise<string[]> {
    const users: string[] = [];
    for (const user_id of await this.repo.listUserIds()) {
      const { buffer } = await this.getBufferAndSummary(user_id);
      if (buffer.length > 0) users.push(user_id);
    }
    return users;
  }

  async listMemories(): Promise<{ user_id: string; date: string; is_self: boolean }[]> {
    const rows = await this.repo.listMemories();
    return rows.map((r) => ({ ...r, is_self: r.user_id === BOT_SELF_ID }));
  }

  async deleteMemory(user_id: string): Promise<void> {
    await this.repo.deleteMemory(user_id);
  }

  async deleteAllMemories(): Promise<void> {
    await this.repo.deleteAllMemories();
  }

  async getMemorySummary(user_id: string): Promise<string> {
    const mem = await this.getMemory(user_id);
    const profile = mem.profile;
    const notes = mem.notes || '';
    const summary = mem.summary || '';

    let finalText = `Notas Básicas: ${notes}\n`;
    if (summary) finalText += `RESUMEN DETALLADO A LARGO PLAZO:\n${summary}\n`;

    const queuedMsgs = await this.queue.getQueuedInteractions(user_id);
    if (queuedMsgs.length) {
      finalText += `MEMORIA RECIENTE (No procesada):\n${queuedMsgs.join('\n')}\n`;
    }

    if (profile.name) finalText += `Nombre: ${profile.name}\n`;
    if (profile.likes.length) finalText += `Gustos: ${profile.likes.join(', ')}\n`;

    return finalText;
  }

  async updateLastChannel(user_id: string, channelId: any): Promise<void> {
    const agg = UserMemoryAggregate.fromRaw(await this.repo.getMemory(user_id));
    agg.touchChannel(channelId);
    await this.repo.saveMemory(user_id, agg.raw);
  }

  async getAllUsersData(): Promise<
    { user_id: string; last_channel_id: number | null; summary: string }[]
  > {
    const out: { user_id: string; last_channel_id: number | null; summary: string }[] = [];
    for (const user_id of await this.repo.listUserIds()) {
      out.push({
        user_id,
        last_channel_id: (await this.getMemory(user_id)).last_channel_id,
        summary: await this.getMemorySummary(user_id),
      });
    }
    return out;
  }

  async addToQueue(user_id: string, text: any): Promise<void> {
    return this.queue.addToQueue(user_id, text);
  }

  async getQueuedInteractions(user_id: string): Promise<string[]> {
    return this.queue.getQueuedInteractions(user_id);
  }

  async processQueue(): Promise<string[]> {
    return this.queue.processQueue(this.addInteraction.bind(this));
  }
}
