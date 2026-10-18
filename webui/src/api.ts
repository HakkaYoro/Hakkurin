import type { AppConfig, ConfigDraft, MemoryRow, StatsData, StatusInfo } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export const api = {
  config: () => fetch('/api/config').then((r) => json<AppConfig>(r)),
  status: () => fetch('/api/status').then((r) => json<StatusInfo>(r)),
  stats: (days: number) => fetch(`/api/stats?days=${days}`).then((r) => json<StatsData>(r)),
  memories: () => fetch('/api/memories').then((r) => json<{ memories: MemoryRow[] }>(r)),
  memory: (id: string) => fetch(`/api/memories/${id}`).then((r) => json<{ user_id: string; content: string }>(r)),
  saveConfig: (draft: ConfigDraft) => post('/api/update_config', draft),
  restart: () => post('/api/restart', {}),
  deleteMemory: (id: string) => post(`/api/memories/${id}/delete`, {}),
  deleteAllMemories: () => post('/api/memories/delete_all', {}),
};
