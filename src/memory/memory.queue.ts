import { promises as fs } from 'fs';
import * as path from 'path';

// Cola temporal persistente de interacciones con dedupe (hexagonal). No conoce
// la política de promoción a memoria permanente: processQueue la recibe por
// parámetro (inversión), así la cola decide CUÁNDO promover y el dominio CÓMO.

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

export class MemoryQueue {
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
    const uid = String(user_id).trim();
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
    const uid = String(user_id).trim();
    return queue.filter((i) => i.user_id === uid).map((i) => i.text);
  }

  // process_queue (memory_manager.py:411-438). `promote` promueve una
  // interacción a memoria permanente y devuelve si hay que resumir ese usuario.
  async processQueue(promote: (userId: string, text: string) => Promise<boolean>): Promise<string[]> {
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
  }
}
