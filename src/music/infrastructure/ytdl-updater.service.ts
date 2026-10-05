// El bucle de "espera mientras suena algo" ES este @Interval: si hay reproducción,
// retorna y re-verifica en la próxima hora. POST /update = pip -U + exit; compose
// (unless-stopped) lo levanta fresco.
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '../../common/config.service';
import { delay } from '../../common/util';
import { MusicService } from '../application/music.service';

const CHECK_TIMEOUT_MS = 15_000;
// pip puede tardar: la respuesta del sidecar llega tras terminar el install.
const UPDATE_TIMEOUT_MS = 300_000;
// Tras el self-kill del /update, compose lo reinicia (~2-20s). Si no vuelve en
// 60s quedó en crash-loop (pip a medias/OOM).
const RECOVERY_POLL_MS = 5_000;
const RECOVERY_TIMEOUT_MS = 60_000;

@Injectable()
export class YtdlUpdaterService {
  private readonly logger = new Logger(YtdlUpdaterService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly music: MusicService,
  ) {}

  @Interval(3_600_000)
  async checkForUpdate(): Promise<void> {
    // Guard de reentrada (patrón de los loops de DiscordAdapter): el update
    // puede tardar minutos; el setInterval crudo dispararía una 2ª concurrente.
    if (this.running) return;
    this.running = true;
    try {
      if (!this.music.isIdle()) {
        this.logger.log('Reproducción activa: la actualización de yt-dlp espera otra hora.');
        return;
      }
      const base = this.config.sidecarUrl();
      const version = await this.getJson(`${base}/version`);
      if (!version?.installed || !version?.latest) {
        this.logger.warn('Sidecar no reportó versiones (installed/latest); se reintenta en una hora.');
        return;
      }
      // El sidecar nuevo normaliza versiones (PyPI quita ceros: 2026.08.19 ≠
      // "2026.8.19" por string) y decide con up_to_date; fallback por si el
      // contenedor aún corre la imagen vieja durante un deploy.
      if (version.up_to_date ?? version.installed === version.latest) return;

      // Doble check: pudo empezar a sonar algo mientras consultábamos PyPI.
      if (!this.music.isIdle()) {
        this.logger.log('Empezó reproducción entre chequeos: actualización aplazada otra hora.');
        return;
      }
      this.logger.log(`yt-dlp ${version.installed} → ${version.latest}: actualizando sidecar...`);
      // El sidecar responde y a los ~1s se mata a sí mismo; compose lo levanta
      // fresco. Que la conexión caiga a mitad es el final NORMAL del update;
      // un 500 (pip falló) o un timeout NO lo son y quedan como warn.
      await fetch(`${base}/update`, { method: 'POST', signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS) })
        .then(async (res) => {
          if (!res.ok) throw new Error(`pip falló: HTTP ${res.status}`);
          this.logger.log('Sidecar actualizado y reiniciándose con el yt-dlp nuevo.');
        })
        .catch((e: any) => {
          const reason = e?.cause?.code ?? e?.name ?? e?.message;
          this.logger.warn(`Update de yt-dlp no confirmado (${reason}); se reintenta en una hora.`);
        });
      await this.awaitSidecarBack(base);
    } catch (e: any) {
      // Sidecar caído o sin red: se reintenta la próxima hora, sin reventar el loop.
      this.logger.warn(`No pude verificar/actualizar yt-dlp: ${e?.message}`);
    } finally {
      this.running = false;
    }
  }

  // Poll post-restart: si el sidecar no levanta tras el update, avisar YA en vez
  // de dejar música rota una hora sin señal. No intenta arreglarlo (docker ya
  // reintenta solo); sólo da visibilidad para los logs exportables.
  private async awaitSidecarBack(base: string): Promise<void> {
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(RECOVERY_POLL_MS);
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        if (res.ok) {
          this.logger.log('Sidecar de vuelta tras el update.');
          return;
        }
      } catch {
        // aún caído: seguir sondeando hasta el deadline
      }
    }
    this.logger.error('Sidecar NO volvió tras el update de yt-dlp (¿crash-loop?). Revisa `docker logs` del sidecar.');
  }

  private async getJson(url: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
