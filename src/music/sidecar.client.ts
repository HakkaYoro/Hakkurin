// Adaptador StreamSource: resuelve la URL de stream de un QueueItem.
// Navidrome trae URL de stream directa; YouTube se resuelve vía sidecar yt-dlp
// (sidecar/extract_server.py). NUNCA loguear la stream_url resultante (sólo la
// URL pública del item).
import { Logger } from '@nestjs/common';
import { ConfigService } from '../common/config.service';
import type { QueueItem } from './music.domain';
import type { StreamSource } from './music.ports';

const SIDECAR_DEFAULT = 'http://localhost:7654';

export class SidecarClient implements StreamSource {
  private readonly logger = new Logger(SidecarClient.name);

  constructor(private readonly config: ConfigService) {}

  async resolve(item: QueueItem): Promise<{ streamUrl: string; title?: string }> {
    if (item.type === 'navidrome') return { streamUrl: item.url };
    // YouTube → sidecar yt-dlp extrae la URL directa de stream.
    const sidecar = this.config.get<string>('ytdl_sidecar_url', SIDECAR_DEFAULT);
    const url = `${sidecar}/extract?url=${encodeURIComponent(item.url)}`;

    let res: Response;
    try {
      // ponytail: AbortSignal.timeout (stdlib) — bounda la llamada; un sidecar
      // colgado no bloquea playNext indefinidamente.
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e: any) {
      // "fetch failed" esconde la razón en e.cause (ECONNREFUSED/ENOTFOUND/TimeoutError…).
      const c = e?.cause;
      const reason = c?.code ?? c?.syscall ?? c?.hostname ?? e?.name ?? e?.message;
      this.logger.warn(`Sidecar yt-dlp falló para ${item.url}: ${reason}`);
      return { streamUrl: '' };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 502 = yt-dlp desactualizado/bot-blocked; 404 = sin resultados; 500 = URL no resuelta.
      this.logger.warn(`Sidecar ${res.status} para ${item.url}: ${body.slice(0, 200)}`);
      return { streamUrl: '' };
    }

    const data: any = await res.json().catch(() => null);
    if (!data?.stream_url) {
      this.logger.warn(`Sidecar 200 sin stream_url para ${item.url}`);
      return { streamUrl: '' };
    }
    // Título perezoso: mutar el item (misma referencia que vive en la cola y en
    // playHistory) para que /queue y el "now playing" lo vean.
    if (!item.title && data.title) item.title = data.title;
    return { streamUrl: data.stream_url, title: data.title };
  }
}
