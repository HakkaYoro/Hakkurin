import http from 'node:http';
import https from 'node:https';
import { setDefaultResultOrder } from 'node:dns';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LogTeeService } from './web/infrastructure/log-tee.service';

async function bootstrap() {
  // IPv4 saliente forzado ANTES de crear la app: el IPv6 de esta máquina rompe el
  // VoiceWebSocket de @discordjs/voice (cae sobre AAAA). family:4 excluye AAAA
  // (setDefaultResultOrder sólo reordena); @discordjs/voice no expone agent.
  http.globalAgent = new http.Agent({ family: 4 });
  https.globalAgent = new https.Agent({ family: 4 });
  setDefaultResultOrder('ipv4first');

  const app = await NestFactory.create(AppModule);
  // LogTee como logger global: además de stdout, ring buffer para GET /logs de la WebUI.
  const logTee = app.get(LogTeeService);
  app.useLogger(logTee);

  // El pacer de 20ms de voz vive en este event-loop: percentiles cada 30s para
  // correlacionar micro-cortes de audio.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  // percentiles() devuelve NANOSEGUNDOS (bug de unidades preexistente) → /1e6 para ms.
  setInterval(() => {
    logTee.log(
      `[eventloop] p50=${(loop.percentile(50) / 1e6).toFixed(1)}ms ` +
        `p99=${(loop.percentile(99) / 1e6).toFixed(1)}ms ` +
        `p99.9=${(loop.percentile(99.9) / 1e6).toFixed(1)}ms`,
    );
  }, 30_000).unref();

  // '::' es sólo el bind entrante del WebUI (el forzado IPv4 saliente va aparte).
  await app.listen(process.env.PORT ?? 8000, process.env.WEBUI_HOST ?? '::');
}

bootstrap().catch((err) => {
  console.error('Fallo arrancando Hakkurin:', err);
  process.exit(1);
});
