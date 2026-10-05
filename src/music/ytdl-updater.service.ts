// Auto-actualización horaria de yt-dlp SIN re-buildear la imagen del sidecar.
// El bucle de "espera mientras suena algo" ES este @Interval: si hay
// reproducción, retorna y re-verifica en la próxima hora (semántica pedida).
// El sidecar expone GET /version (instalada vs PyPI) y POST /update (pip -U +
// salida limpia; compose restart: unless-stopped lo levanta fresco).
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '../common/config.service';
import { MusicService } from './music.service';

const SIDECAR_DEFAULT = 'http://localhost:7654';
const CHECK_TIMEOUT_MS = 15_000;
// pip puede tardar: la respuesta del sidecar llega tras terminar el install.
const UPDATE_TIMEOUT_MS = 300_000;

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
    // Guard de reentrada (patrón de los loops de DiscordService): el update
    // puede tardar minutos; el setInterval crudo dispararía una 2ª concurrente.
    if (this.running) return;
    this.running = true;
    try {
      if (!this.music.isIdle()) {
        this.logger.log('Reproducción activa: la actualización de yt-dlp espera otra hora.');
        return;
      }
      const base = this.config.get<string>('ytdl_sidecar_url', SIDECAR_DEFAULT);
      const version = await this.getJson(`${base}/version`);
      if (!version?.installed || !version?.latest) {
        this.logger.warn('Sidecar no reportó versiones (installed/latest); se reintenta en una hora.');
        return;
      }
      if (version.installed === version.latest) return;

      // Doble check: pudo empezar a sonar algo mientras consultábamos PyPI.
      if (!this.music.isIdle()) {
        this.logger.log('Empezó reproducción entre chequeos: actualización aplazada otra hora.');
        return;
      }
      this.logger.log(`yt-dlp ${version.installed} → ${version.latest}: actualizando sidecar...`);
      // El sidecar responde y a los ~1s se mata a sí mismo; compose lo levanta
      // fresco. Que la conexión caiga a mitad es el final NORMAL del update.
      await fetch(`${base}/update`, { method: 'POST', signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS) }).catch(
        (e: any) => {
          const reason = e?.cause?.code ?? e?.name ?? e?.message;
          this.logger.log(`Sidecar cerró durante el update (esperado): ${reason}`);
        },
      );
      this.logger.log('Sidecar actualizado y reiniciándose con el yt-dlp nuevo.');
    } catch (e: any) {
      // Sidecar caído o sin red: se reintenta la próxima hora, sin reventar el loop.
      this.logger.warn(`No pude verificar/actualizar yt-dlp: ${e?.message}`);
    } finally {
      this.running = false;
    }
  }

  private async getJson(url: string): Promise<any> {
    const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
