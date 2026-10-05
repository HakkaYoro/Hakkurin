import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite } from '../../../common/util';
import { MemoryQueuePort } from '../../domain/ports/memory.ports';

export const QUEUE_FILE = 'data/memory/queue.json';

const QUEUE_TO_PERMANENT_DELAY_SECONDS = 300;
const QUEUE_DUPLICATE_WINDOW_SECONDS = 10;

interface QueueItem {
  user_id: string;
  text: string;
  timestamp: number;
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
export class MemoryQueueAdapter extends MemoryQueuePort {
  // Mutex de promesa encadenada: serializa las secciones load→modify→save
  // (dos escrituras concurrentes podrían clobber el JSON). Nada de la cola
  // puede llamarse dentro de la sección exclusiva (promote incluido): deadlock.
  private tail: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  }

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
    await atomicWrite(QUEUE_FILE, JSON.stringify(safe, null, 2));
  }

  async addToQueue(user_id: string, text: any): Promise<void> {
    if (text == null) return;
    const t = String(text).trim();
    const uid = String(user_id).trim();
    if (!t || !uid) return;

    await this.exclusive(async () => {
      const queue = await this.loadQueue();
      const now = Date.now() / 1000;

      // Dedupe rápida (10s): evita duplicados inmediatos por reintentos/cancelaciones.
      for (let i = queue.length - 1; i >= Math.max(0, queue.length - 50); i--) {
        const item = queue[i];
        if (item.user_id === uid && item.text === t && now - item.timestamp <= QUEUE_DUPLICATE_WINDOW_SECONDS) {
          return;
        }
      }

      queue.push({ user_id: uid, text: t, timestamp: now });
      await this.saveQueue(queue);
    });
  }

  async getQueuedInteractions(user_id: string): Promise<string[]> {
    const queue = await this.loadQueue();
    const uid = String(user_id).trim();
    return queue.filter((i) => i.user_id === uid).map((i) => i.text);
  }

  // `promote` añade a memoria permanente y devuelve si hay que resumir ese
  // usuario (la política vive en MemoryService).
  async processQueue(promote: (userId: string, text: string) => Promise<boolean>): Promise<string[]> {
    return this.exclusive(async () => {
      const queue = await this.loadQueue();
      if (!queue.length) return [];

      const now = Date.now() / 1000;
      const newQueue: QueueItem[] = [];
      const usersToSummarize = new Set<string>();

      for (const item of queue) {
        if (now - item.timestamp > QUEUE_TO_PERMANENT_DELAY_SECONDS) {
          const shouldSum = await promote(item.user_id, item.text);
          if (shouldSum) usersToSummarize.add(item.user_id);
        } else {
          newQueue.push(item);
        }
      }

      if (newQueue.length !== queue.length) await this.saveQueue(newQueue);
      return [...usersToSummarize];
    });
  }
}
