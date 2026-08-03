import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CryptoService } from './crypto.service';

// Puerto fiel de core/memory_manager.py. Memoria por usuario cifrada AES-256-GCM,
// esquema normalizado defensivamente, cola temporal con dedupe, self-memory
// (BOT_SELF_ID), espejo plano de resumen para el WebUI. Escrituras atómicas.

const MEMORY_DIR = 'data/memory/users';
const SUMMARY_DIR = 'data/memory/summaries';
const QUEUE_FILE = 'data/memory/queue.json';

const QUEUE_TO_PERMANENT_DELAY_SECONDS = 300;
const STALE_BUFFER_SECONDS = 1800;
const SUMMARY_TRIGGER_SECONDS = 1800;
const SUMMARY_TRIGGER_INTERACTIONS = 20;
const QUEUE_DUPLICATE_WINDOW_SECONDS = 10;

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

interface QueueItem {
  user_id: string;
  text: string;
  timestamp: number;
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

function normalizeQueueItem(item: any): QueueItem | null {
  if (!item || typeof item !== 'object') return null;
  const user_id = item.user_id;
  const text = item.text;
  if (user_id == null || text == null) return null;
  const uid = String(user_id).trim();
  const t = String(text).trim();
  if (!uid || !t) return null;
  const ts = Number(item.timestamp);
  return { user_id: uid, text: t, timestamp: Number.isFinite(ts) ? ts : Date.now() / 1000 };
}

@Injectable()
export class MemoryService implements OnModuleInit {
  private readonly logger = new Logger(MemoryService.name);

  constructor(private readonly crypto: CryptoService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    await fs.mkdir(SUMMARY_DIR, { recursive: true });
    await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  }

  private filePath(user_id: string): string {
    return path.join(MEMORY_DIR, `${this.sanitizeUserId(user_id)}.enc`);
  }

  private sanitizeUserId(user_id: any): string {
    return String(user_id).trim();
  }

  private async atomicWriteBytes(filePath: string, data: Buffer): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  }

  private async atomicWriteText(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
  }

  // get_memory (memory_manager.py:118-132)
  async getMemory(user_id: string): Promise<UserMemory> {
    const filePath = this.filePath(user_id);
    try {
      const data = await fs.readFile(filePath);
      const decrypted = this.crypto.decrypt(data);
      return normalizeMemorySchema(JSON.parse(decrypted));
    } catch (e: any) {
      if (e.code !== 'ENOENT') this.logger.warn(`Error leyendo memoria de ${user_id}: ${e.message}`);
      return createEmptyMemory();
    }
  }

  // save_memory (memory_manager.py:134-143)
  async saveMemory(user_id: string, memoryData: any): Promise<void> {
    const filePath = this.filePath(user_id);
    try {
      const normalized = normalizeMemorySchema(memoryData);
      const json = JSON.stringify(normalized);
      await this.atomicWriteBytes(filePath, this.crypto.encrypt(json));
    } catch (e: any) {
      this.logger.error(`Error guardando memoria de ${user_id}: ${e.message}`);
    }
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
    await this.saveSummaryPlaintext(user_id, mem.summary);
  }

  private async saveSummaryPlaintext(user_id: string, summaryText: string): Promise<void> {
    const filePath = path.join(SUMMARY_DIR, `${user_id}.txt`);
    try {
      await this.atomicWriteText(filePath, summaryText ?? '');
    } catch (e: any) {
      this.logger.warn(`Error guardando resumen plano de ${user_id}: ${e.message}`);
    }
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
    let files: string[];
    try {
      files = await fs.readdir(MEMORY_DIR);
    } catch {
      return [];
    }
    const out: { user_id: string; date: string; is_self: boolean }[] = [];
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const filename of files) {
      if (!filename.endsWith('.enc')) continue;
      const user_id = filename.replace(/\.enc$/, '');
      try {
        const d = new Date((await fs.stat(path.join(MEMORY_DIR, filename))).mtimeMs);
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        out.push({ user_id, date, is_self: user_id === BOT_SELF_ID });
      } catch {
        /* archivo desaparecido entre readdir y stat */
      }
    }
    out.sort((a, b) => (a.date < b.date ? 1 : -1));
    return out;
  }

  // get_memory_summary (memory_manager.py:273-295)
  async getMemorySummary(user_id: string): Promise<string> {
    const mem = await this.getMemory(user_id);
    const profile = mem.profile;
    const notes = mem.notes || '';
    const summary = mem.summary || '';

    let finalText = `Notas Básicas: ${notes}\n`;
    if (summary) finalText += `RESUMEN DETALLADO A LARGO PLAZO:\n${summary}\n`;

    const queuedMsgs = await this.getQueuedInteractions(user_id);
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

  // --- QUEUE ---
  private async loadQueue(): Promise<QueueItem[]> {
    try {
      const raw = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf-8'));
      if (!Array.isArray(raw)) return [];
      const normalized: QueueItem[] = [];
      for (const item of raw) {
        const safe = normalizeQueueItem(item);
        if (safe) normalized.push(safe);
      }
      return normalized;
    } catch {
      return [];
    }
  }

  private async saveQueue(queue: QueueItem[]): Promise<void> {
    await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
    const safe: QueueItem[] = [];
    for (const item of queue) {
      const s = normalizeQueueItem(item);
      if (s) safe.push(s);
    }
    const tmp = `${QUEUE_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(safe, null, 2), 'utf-8');
    await fs.rename(tmp, QUEUE_FILE);
  }

  // add_to_queue (memory_manager.py:382-402)
  async addToQueue(user_id: string, text: any): Promise<void> {
    if (text == null) return;
    const t = String(text).trim();
    const uid = this.sanitizeUserId(user_id);
    if (!t || !uid) return;

    const queue = await this.loadQueue();
    const now = Date.now() / 1000;

    // Dedupe rápida: evita duplicados inmediatos por reintentos/cancelaciones.
    for (let i = queue.length - 1; i >= Math.max(0, queue.length - 50); i--) {
      const item = queue[i];
      if (item.user_id === uid && item.text === t && now - item.timestamp <= QUEUE_DUPLICATE_WINDOW_SECONDS) {
        return;
      }
    }

    queue.push({ user_id: uid, text: t, timestamp: now });
    await this.saveQueue(queue);
  }

  async getQueuedInteractions(user_id: string): Promise<string[]> {
    const queue = await this.loadQueue();
    const uid = this.sanitizeUserId(user_id);
    return queue.filter((i) => i.user_id === uid).map((i) => i.text);
  }

  // process_queue (memory_manager.py:411-438)
  async processQueue(): Promise<string[]> {
    const queue = await this.loadQueue();
    if (!queue.length) return [];

    const now = Date.now() / 1000;
    const newQueue: QueueItem[] = [];
    const usersToSummarize = new Set<string>();

    for (const item of queue) {
      if (now - item.timestamp > QUEUE_TO_PERMANENT_DELAY_SECONDS) {
        const shouldSum = await this.addInteraction(item.user_id, item.text);
        if (shouldSum) usersToSummarize.add(item.user_id);
      } else {
        newQueue.push(item);
      }
    }

    if (newQueue.length !== queue.length) await this.saveQueue(newQueue);
    return [...usersToSummarize];
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
