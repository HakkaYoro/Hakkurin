// Adaptador AudioPipeline: ffmpeg emite Opus 48k estéreo directo
// (StreamType.OggOpus, sin re-encode JS); el volumen se aplica vía filtro de
// ffmpeg. Un PassThrough de read-ahead (BUFFER_BYTES) amortigua el jitter de
// fuente/red para evitar stutter (el buffer del OggDemuxer interno es ~320ms).
// Opera sobre el GuildMusicState pasado (s.ffmpeg lo pican los tests).
import { Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { StreamType, createAudioResource, type AudioResource } from '@discordjs/voice';
import type { GuildMusicState } from './music.domain';
import type { AudioPipeline } from './music.ports';

const VOLUME = 0.5;
// Buffer de read-ahead entre ffmpeg y el OggDemuxer. Sin coste de latencia (sólo
// gobierna backpressure al writer); aguanta ~1-2min de Opus ante un stall de fuente.
const BUFFER_BYTES = 1024 * 1024;

export class FfmpegAdapter implements AudioPipeline {
  private readonly logger = new Logger(FfmpegAdapter.name);

  killCurrent(s: GuildMusicState): void {
    if (s.ffmpeg) { try { s.ffmpeg.kill('SIGKILL'); } catch {} s.ffmpeg = null; }
  }

  create(s: GuildMusicState, streamUrl: string): AudioResource | null {
    if (!streamUrl) return null;
    // Cortar cualquier ffmpeg previo (skip/stop/reemplazo de track).
    this.killCurrent(s);

    // ffmpeg → Opus estéreo 48k directo (sin re-encode JS/opusscript). Volumen vía
    // filtro de ffmpeg. Salida por pipe a un PassThrough con read-ahead grande.
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

    // Buffer de read-ahead: amortigua jitter de fuente/red (sin coste de latencia:
    // highWaterMark sólo gobierna el backpressure al writer).
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

    return createAudioResource(buf, { inputType: StreamType.OggOpus, inlineVolume: false });
  }
}
