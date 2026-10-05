// Adaptador StreamSource: resuelve la URL de stream de un QueueItem.
// Navidrome trae URL de stream directa; YouTube se resuelve vía sidecar yt-dlp
// (sidecar/extract_server.py). NUNCA loguear la stream_url resultante (sólo la
// URL pública del item).
import { Logger } from '@nestjs/common';
import { ConfigService } from '../common/config.service';
import { delay } from '../common/util';
import type { QueueItem } from './music.domain';
import type { StreamSource } from './music.ports';

const SIDECAR_DEFAULT = 'http://localhost:7654';
const EXTRACT_TIMEOUT_MS = 20_000;
const RESET_TIMEOUT_MS = 5_000;
// Tras POST /reset (lo dispara /stop) el contenedor tarda ~2s en volver; un
// extract que llegue en ese hueco se rechaza con ECONNREFUSED.
const CONN_ERR_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'];

export class SidecarClient implements StreamSource {
  private readonly logger = new Logger(SidecarClient.name);

  constructor(private readonly config: ConfigService) {}

  private sidecarUrl(): string {
    // Env manda sobre config: en compose lo fija YTDL_SIDECAR_URL (docker-compose.yml)
    // y elimina el paso manual de la WebUI — un config vacío dejaba el default
    // localhost:7654, que dentro del contenedor del bot es ECONNREFUSED permanente.
    return process.env.YTDL_SIDECAR_URL || this.config.get<string>('ytdl_sidecar_url', SIDECAR_DEFAULT);
  }

  private extractSignal(external?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(EXTRACT_TIMEOUT_MS);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  /** Mata el proceso del sidecar (compose lo reinicia limpio). Fire-and-forget:
   *  lo llama /stop para garantizar yt-dlp fresco aunque un extract quede wedged. */
  reset(): void {
    void fetch(`${this.sidecarUrl()}/reset`, { method: 'POST', signal: AbortSignal.timeout(RESET_TIMEOUT_MS) })
      .catch(() => {});
  }

  async resolve(item: QueueItem, signal?: AbortSignal): Promise<{ streamUrl: string; title?: string }> {
    if (item.type === 'navidrome') return { streamUrl: item.url };
    // YouTube → sidecar yt-dlp extrae la URL directa de stream.
    const url = `${this.sidecarUrl()}/extract?url=${encodeURIComponent(item.url)}`;

    let res: Response;
    // Reinicio reciente del sidecar (/stop ~2s) o self-kill del /update (restart
    // de compose puede tardar >10s) → ventanas con ECONNREFUSED. Reintentos a 3s
    // y 12s cubren ambas; si sigue caído es un problema real (crash-loop/stop).
    const RETRY_DELAYS_MS = [3_000, 12_000];
    for (let attempt = 0; ; attempt++) {
      try {
        // ponytail: AbortSignal.timeout (stdlib) — bounda la llamada; un sidecar
        // colgado no bloquea playNext indefinidamente.
        res = await fetch(url, { signal: this.extractSignal(signal) });
        break;
      } catch (e: any) {
        // "fetch failed" esconde la razón en e.cause (ECONNREFUSED/ENOTFOUND/TimeoutError…).
        if (e?.name === 'AbortError' || signal?.aborted) return { streamUrl: '' }; // /stop canceló: ni warn ni retry
        const c = e?.cause;
        const reason = c?.code ?? c?.syscall ?? c?.hostname ?? e?.name ?? e?.message;
        const terminated = e?.name === 'TypeError' || String(e?.message).includes('terminated') || String(c?.code).startsWith('UND_ERR');
        if ((CONN_ERR_CODES.includes(c?.code) || terminated) && attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        this.logger.warn(
          `Sidecar yt-dlp falló tras ${attempt + 1} intento(s) para ${item.url}: ${reason}` +
            (attempt > 0 ? ' — ¿sidecar caído (crash-loop/stop)? Revisa el contenedor y ytdl_sidecar_url.' : ''),
        );
        return { streamUrl: '' };
      }
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
