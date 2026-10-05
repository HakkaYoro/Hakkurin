import http from 'node:http';
import https from 'node:https';
import { setDefaultResultOrder } from 'node:dns';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LogTeeService } from './web/log-tee.service';

async function bootstrap() {
  // Force IPv4 a nivel socket (porteo del source_address '0.0.0.0' del Python legacy,
  // docs/05-music-system.md:64). Esta máquina tiene IPv6 problemático para voz: el
  // VoiceWebSocket de @discordjs/voice (wss → https.globalAgent) cae sobre IPv6 y se
  // desconecta antes de llegar a Ready. family:4 excluye AAAA (más fuerte que
  // setDefaultResultOrder, que sólo reordena). @discordjs/voice no expone opción de agent,
  // así que forzamos el global. Discord/Gemini/sidecar toleran IPv4.
  http.globalAgent = new http.Agent({ family: 4 });
  https.globalAgent = new https.Agent({ family: 4 });
  setDefaultResultOrder('ipv4first');

  const app = await NestFactory.create(AppModule);
  // Tee de logs: todo lo que Nest imprime queda además en un ring buffer en
  // memoria para la descarga GET /logs de la WebUI (stdout del contenedor no).
  const logTee = app.get(LogTeeService);
  app.useLogger(logTee);

  // Diagnóstico de stutter: el pacer de 20ms de voz de @discordjs/voice vive en
  // este event-loop; si se bloquea (sync pesado, GC), Discord recibe silencio
  // aunque el buffer de audio esté lleno. Log de percentiles cada 30s para
  // correlacionar con micro-cortes.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  // percentiles() devuelve NANOSEGUNDOS (bug de unidades preexistente: el log
  // decía "ms" y asustaba con p50 de 10 millones) → /1e6 para ms reales.
  setInterval(() => {
    logTee.log(
      `[eventloop] p50=${(loop.percentile(50) / 1e6).toFixed(1)}ms ` +
        `p99=${(loop.percentile(99) / 1e6).toFixed(1)}ms ` +
        `p99.9=${(loop.percentile(99.9) / 1e6).toFixed(1)}ms`,
    );
  }, 30_000).unref();

  // Escuchar en '::' (todas las interfaces, IPv4 + IPv6) para que el WebUI sea
  // accesible desde la red. Sobreescribible con la variable WEBUI_HOST.
  // Nota: el forzado de IPv4 para las conexiones *salientes* (Discord/Gemini/sidecar)
  // se mantiene arriba; '::' sólo afecta al servidor HTTP entrante.
  await app.listen(process.env.PORT ?? 8000, process.env.WEBUI_HOST ?? '::');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fallo arrancando Hakkurin:', err);
  process.exit(1);
});
