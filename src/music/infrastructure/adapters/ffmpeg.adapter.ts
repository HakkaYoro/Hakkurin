import { Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { StreamType, createAudioResource } from '@discordjs/voice';
import { delay } from '../../../common/util';
import type { GuildMusicState, PlayerHandle } from '../../domain/music.domain';
import type { AudioPipeline } from '../../domain/ports/music.ports';

const VOLUME = 0.5;
// Buffer de read-ahead entre ffmpeg y el OggDemuxer (cuyo buffer interno es
// ~320ms). Sin coste de latencia (sólo gobierna backpressure al writer); aguanta
// ~1-2min de Opus ante un stall de fuente.
const BUFFER_BYTES = 1024 * 1024;
// Pre-buffer (anti-stutter): pausa tras spawn ffmpeg para que llene el PassThrough
// antes de sonar. CPU modesto (i5-2400) + canal de voz 64k → 5s de colchón.
const PREBUFFER_MS = 5_000;

export class FfmpegAdapter implements AudioPipeline {
  private readonly logger = new Logger(FfmpegAdapter.name);

  killCurrent(s: GuildMusicState): void {
    if (s.ffmpeg) { try { s.ffmpeg.kill('SIGKILL'); } catch {} s.ffmpeg = null; }
  }

  async createAndPlay(s: GuildMusicState, streamUrl: string, player: PlayerHandle): Promise<boolean> {
    if (!streamUrl) return false;
    this.killCurrent(s);

    // Opus 48k estéreo directo (sin re-encode JS/opusscript); volumen vía filtro.
    const ff = spawn('ffmpeg', [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      // read-ahead del thread de input: sin esto puede starvarse periódicamente y
      // producir gaps que el PassThrough (que vive después de ffmpeg) no puede tapar.
      '-thread_queue_size', '512',
      '-i', streamUrl,
      // Encoding ligero para CPU modesto (i5-2400): libopus@96k sobra para el canal
      // de voz de Discord (64k); compression_level bajo = mucho menos CPU con pérdida
      // mínima de calidad. -f opus mantiene el container Ogg/Opus que lee @discordjs/voice.
      '-c:a', 'libopus', '-b:a', '96k', '-compression_level', '3',
      '-f', 'opus', '-ar', '48000', '-ac', '2',
      '-filter:a', `volume=${VOLUME}`,
      '-loglevel', 'error', '-hide_banner', 'pipe:1',
    ]);
    s.ffmpeg = ff;
    // Drenar stderr: debug + evita que el pipe kernel (64KB) se llene en bucles de
    // error y atasque stdout (→ underrun → stutter).
    ff.stderr.on('data', (d: Buffer) => this.logger.debug(`ffmpeg: ${d.toString().trim()}`));
    ff.on('error', (e) => this.logger.error(`ffmpeg spawn falló: ${e.message}. ¿ffmpeg instalado?`));
    ff.once('exit', () => { if (s.ffmpeg === ff) s.ffmpeg = null; });

    const buf = new PassThrough({ highWaterMark: BUFFER_BYTES });
    ff.stdout.pipe(buf);
    ff.stdout.on('error', () => {}); // tragar EPIPE tras kill
    buf.on('error', () => {});

    // Forzar EOF del buffer al cerrar ffmpeg. Sin esto el PassThrough puede no
    // propagar el fin → el AudioResource nunca termina → el player no pasa a Idle
    // → la cola no avanza (bug de avance + radio). 'close' se emite siempre
    // (natural o tras SIGKILL) y tras el cierre de los stdio, así que buf ya recibió
    // todo el Opus. Idempotente si el pipe ya había terminado. Si esto no dispara
    // Idle en vivo, subir a buf.destroy().
    ff.once('close', () => { try { buf.end(); } catch {} });

    await delay(PREBUFFER_MS);
    // Abortado (/stop o skip) durante el pre-buffer: killCurrent ya pisó s.ffmpeg.
    // Sin este chequeo el play dispararía audio muerto sobre una sesión cancelada.
    if (s.ffmpeg !== ff) {
      try { ff.kill('SIGKILL'); } catch {}
      return false;
    }
    player.play(createAudioResource(buf, { inputType: StreamType.OggOpus, inlineVolume: false }));
    return true;
  }
}
