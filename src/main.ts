import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Bind localhost por defecto (protección del WebUI). WEBUI_HOST=0.0.0.0 sólo si hay
  // webui_token configurado y se quiere exponer (ver auth.guard.ts).
  await app.listen(process.env.PORT ?? 8000, process.env.WEBUI_HOST ?? '127.0.0.1');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fallo arrancando Hakkurin:', err);
  process.exit(1);
});
