import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CryptoService } from './crypto.service';
import { MemoryRepository, MEMORY_DIR, SUMMARY_DIR } from './memory.repository';
import { MemoryQueue, QUEUE_FILE } from './memory.queue';

// Puerto fiel de core/memory_manager.py. Esta clase es la política/dominio:
// esquema normalizado defensivamente, umbrales de resumen, self-memory
// (BOT_SELF_ID), espejo plano de resumen para el WebUI. Delega la persistencia
// cifrada en MemoryRepository y la cola temporal en MemoryQueue (a la que pasa
// la promoción por parámetro para no acoplarse a esta política).

const STALE_BUFFER_SECONDS = 1800;
const SUMMARY_TRIGGER_SECONDS = 1800;
const SUMMARY_TRIGGER_INTERACTIONS = 20;

export const BOT_SELF_ID = 'hakkurin_internal_self';

export interface UserProfile {
  name: string;
  personality_traits: string[];
  likes: string[];
  dislikes: string[];
  speaking_style: string;
}

export interface UserMemory {
  profile: UserProfile;
  interaction_count: number;
  last_topics: string[];
  notes: string;
  summary: string;
  history_buffer: string[];
  last_summary_time: number;
  last_channel_id: number | null;
}

function createEmptyMemory(): UserMemory {
  return {
    profile: { name: '', personality_traits: [], likes: [], dislikes: [], speaking_style: '' },
    interaction_count: 0,
    last_topics: [],
    notes: 'Usuario nuevo.',
    summary: '',
    history_buffer: [],
    last_summary_time: 0,
    last_channel_id: null,
  };
}

function isStrIntFloat(v: any): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';
}

// _normalize_memory_schema (memory_manager.py:56-116)
function normalizeMemorySchema(raw: any): UserMemory {
  const mem = !raw || typeof raw !== 'object' ? {} : raw;
  const normalized = createEmptyMemory();
  Object.assign(normalized, mem);

  const profileDefaults = createEmptyMemory().profile;
  const profile = mem.profile && typeof mem.profile === 'object' ? mem.profile : {};
  const safeProfile: UserProfile = { ...profileDefaults };
  for (const key of Object.keys(profileDefaults) as (keyof UserProfile)[]) {
    const value = profile[key] ?? profileDefaults[key];
    if (key === 'personality_traits' || key === 'likes' || key === 'dislikes') {
      safeProfile[key] = Array.isArray(value)
        ? value.filter((v: any) => isStrIntFloat(v)).map((v: any) => String(v))
        : [];
    } else {
      safeProfile[key] = value != null ? String(value) : profileDefaults[key];
    }
  }
  normalized.profile = safeProfile;

  normalized.interaction_count =
    typeof normalized.interaction_count === 'number' && Number.isInteger(normalized.interaction_count)
      ? normalized.interaction_count
      : 0;

  normalized.last_topics = Array.isArray(normalized.last_topics) ? normalized.last_topics : [];
  if (typeof normalized.notes !== 'string') normalized.notes = 'Usuario nuevo.';
  if (typeof normalized.summary !== 'string') normalized.summary = '';
  if (Array.isArray(normalized.history_buffer)) {
    normalized.history_buffer = normalized.history_buffer
      .filter((i: any) => isStrIntFloat(i))
      .map((i: any) => String(i));
  } else {
    normalized.history_buffer = [];
  }

  const lst = Number(normalized.last_summary_time);
  normalized.last_summary_time = Number.isFinite(lst) ? lst : 0;

  const lc = normalized.last_channel_id;
  const lcNum = Number(lc);
  normalized.last_channel_id =
    lc != null && Number.isInteger(lcNum) && Number.isFinite(lcNum) ? lcNum : null;

  return normalized;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

@Injectable()
export class MemoryService implements OnModuleInit {
  private readonly logger = new Logger(MemoryService.name);
  private readonly repo: MemoryRepository;
  private readonly queue: MemoryQueue;

  // Constructor público sin cambios: los tests lo construyen directo con
  // `new MemoryService(crypto)`; repo/queue se montan por defecto aquí dentro.
  constructor(private readonly crypto: CryptoService) {
    this.repo = new MemoryRepository(crypto);
    this.queue = new MemoryQueue();
  }

  async onModuleInit(): Promise<void> {
    await this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    await fs.mkdir(SUMMARY_DIR, { recursive: true });
    await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  }

  // ponytail: delegados filePath/atomicWriteBytes existen sólo para que los
  // tests sigan tocando internals vía as-any; el dominio ya no los usa.
  private filePath(user_id: string): string {
    return (this.repo as any).filePath(user_id);
  }

  private async atomicWriteBytes(filePath: string, data: Buffer): Promise<void> {
    return (this.repo as any).atomicWriteBytes(filePath, data);
  }

  // get_memory (memory_manager.py:118-132). El repo devuelve el JSON crudo
  // (o {} si el archivo no existía/corrompía); la normalización es dominio.
  async getMemory(user_id: string): Promise<UserMemory> {
    return normalizeMemorySchema(await this.repo.getMemory(user_id));
  }

  // save_memory (memory_manager.py:134-143). Normaliza antes de persistir.
  async saveMemory(user_id: string, memoryData: any): Promise<void> {
    await this.repo.saveMemory(user_id, normalizeMemorySchema(memoryData));
  }

  // add_interaction (memory_manager.py:163-183)
  async addInteraction(user_id: string, interactionText: any): Promise<boolean> {
    if (interactionText == null) return false;
    const text = String(interactionText).trim();
    if (!text) return false;

    const mem = await this.getMemory(user_id);
    mem.history_buffer.push(text);
    mem.interaction_count += 1;

    const now = Date.now() / 1000;
    const timeSinceLast = now - (mem.last_summary_time || 0);
    const shouldSummarize =
      mem.history_buffer.length >= SUMMARY_TRIGGER_INTERACTIONS ||
      (mem.history_buffer.length > 0 && timeSinceLast > SUMMARY_TRIGGER_SECONDS);

    await this.saveMemory(user_id, mem);
    return shouldSummarize;
  }

  // check_stale_buffers (memory_manager.py:185-203)
  async checkStaleBuffers(): Promise<string[]> {
    const users: string[] = [];
    let files: string[];
    try {
      files = await fs.readdir(MEMORY_DIR);
    } catch {
      return users;
    }
    const now = Date.now() / 1000;
    for (const filename of files) {
      if (!filename.endsWith('.enc')) continue;
      const user_id = filename.replace(/\.enc$/, '');
      const mem = await this.getMemory(user_id);
      const buffer = mem.history_buffer;
      const lastSum = mem.last_summary_time || 0;
      if (buffer.length > 0 && now - lastSum > STALE_BUFFER_SECONDS) users.push(user_id);
    }
    return users;
  }

  // --- SELF MEMORY ---
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

  // update_summary (memory_manager.py:223-249)
  async updateSummary(
    user_id: string,
    newSummary: string | null,
    processedInteractions?: string[] | null,
  ): Promise<void> {
    const mem = await this.getMemory(user_id);
    mem.summary = newSummary != null ? String(newSummary) : '';

    const currentBuffer = [...mem.history_buffer];
    if (processedInteractions == null) {
      mem.history_buffer = [];
    } else {
      const processed = processedInteractions.map(String);
      const prefixLen = processed.length;
      if (prefixLen > 0 && arraysEqual(currentBuffer.slice(0, prefixLen), processed)) {
        mem.history_buffer = currentBuffer.slice(prefixLen);
      } else {
        // Si no coincide el prefijo, conservamos el buffer completo para no perder datos.
        mem.history_buffer = currentBuffer;
      }
    }

    mem.last_summary_time = Date.now() / 1000;
    await this.saveMemory(user_id, mem);
    await this.repo.saveSummaryPlaintext(user_id, mem.summary);
  }

  async getUsersWithPendingBuffer(): Promise<string[]> {
    const users: string[] = [];
    let files: string[];
    try {
      files = await fs.readdir(MEMORY_DIR);
    } catch {
      return users;
    }
    for (const filename of files) {
      if (!filename.endsWith('.enc')) continue;
      const user_id = filename.replace(/\.enc$/, '');
      const { buffer } = await this.getBufferAndSummary(user_id);
      if (buffer.length > 0) users.push(user_id);
    }
    return users;
  }

  /** Lista memorias para el WebUI: [{user_id, date, is_self}] ordenado por mtime desc. */
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

  // get_memory_summary (memory_manager.py:273-295)
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
    const mem = await this.getMemory(user_id);
    const num = Number(channelId);
    mem.last_channel_id = Number.isInteger(num) && Number.isFinite(num) ? num : null;
    await this.saveMemory(user_id, mem);
  }

  async getAllUsersData(): Promise<
    { user_id: string; last_channel_id: number | null; summary: string }[]
  > {
    const out: { user_id: string; last_channel_id: number | null; summary: string }[] = [];
    let files: string[];
    try {
      files = await fs.readdir(MEMORY_DIR);
    } catch {
      return out;
    }
    for (const filename of files) {
      if (!filename.endsWith('.enc')) continue;
      const user_id = filename.replace(/\.enc$/, '');
      const mem = await this.getMemory(user_id);
      out.push({
        user_id,
        last_channel_id: mem.last_channel_id,
        summary: await this.getMemorySummary(user_id),
      });
    }
    return out;
  }

  // --- QUEUE (delega en MemoryQueue; API pública intacta) ---
  async addToQueue(user_id: string, text: any): Promise<void> {
    return this.queue.addToQueue(user_id, text);
  }

  async getQueuedInteractions(user_id: string): Promise<string[]> {
    return this.queue.getQueuedInteractions(user_id);
  }

  // process_queue (memory_manager.py:411-438). La política de promoción es
  // addInteraction; la cola la invierte vía parámetro.
  async processQueue(): Promise<string[]> {
    return this.queue.processQueue(this.addInteraction.bind(this));
  }
}
