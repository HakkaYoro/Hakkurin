# Hakkurin — Bot de Discord con personalidad (NestJS)

[![Node](https://img.shields.io/badge/Node-22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs)](https://nestjs.com/)
[![AI](https://img.shields.io/badge/AI-Gemma_4_31B_+_26B-orange?style=flat-square&logo=google)](https://ai.google.dev/)

Hakkurin no es un bot de comandos: es una entidad que "vive" en tu servidor. Escucha,
decide cuándo participar, recuerda quién eres (memoria cifrada por usuario), reproduce
música y puede ignorarte si no le caes bien. Porteado desde Python a **NestJS/TypeScript**;
el original queda en la rama `legacy-python`.

## Características

- **Cerebro Gemma 4** — `gemma-4-31b-it` y `gemma-4-26b-a4b-it` alternados por request
  para repartir cuota; ante 429 el ladder prueba el otro Gemma y después Gemini flash
  como respaldo (40 min de modo fallback). Contexto capado a ~16k tokens, parseo
  defensivo de JSON tras fences (Gemma no soporta JSON mode) y búsqueda web two-pass
  en los modelos de respaldo.
- **Memoria cifrada AES-256-GCM** por usuario + auto-memoria del bot, resúmenes
  automáticos y recordatorios programados.
- **Pipeline probabilístico** — mención, reply, actividad reciente o probabilidad
  configurable; debounce abortable si alguien sigue escribiendo.
- **Música** — YouTube vía sidecar yt-dlp (`player_client=android` anti-429) y Navidrome
  (Subsonic): `/play /skip /stop /queue /search /radio`, radio con auto-prefetch,
  ffmpeg → Opus 48k directo, `/stop` con epoch + abort + reset del sidecar y
  auto-actualización horaria de yt-dlp sin re-buildear imagen.
- **WebUI** — dashboard server-rendered: config en vivo (secretos write-only), browse
  de memorias y **Exportar Logs** (ring buffer en memoria, descarga `hakkurin.log`
  protegida por el mismo AuthGuard HTTP Basic opt-in).
- **Loops de fondo** — timeouts de sesión, cola de memoria, recovery de API,
  festividades, recordatorios y limpieza de canales de voz, con guard de reentrada.

## Stack

NestJS 11 · discord.js 14 · @discordjs/voice · @google/genai · nunjucks · vitest ·
AES-256-GCM vía `node:crypto`. Dos imágenes en GHCR: `bot` (~450 MB, ffmpeg estático)
y `sidecar` (~210 MB, python:3.11-slim + yt-dlp).

## Despliegue (NAS / servidor)

Cada push a `main` publica ambas imágenes en GHCR
(`.github/workflows/docker-publish.yml`). Compose mínimo, sin build local:

```yaml
services:
  hakkurin:
    environment:
      - YTDL_SIDECAR_URL=http://sidecar:7654   # precedencia sobre config.json
    image: ghcr.io/hakkayoro/hakkurin:latest
    ports:
      - '30421:8000'
    restart: unless-stopped
    volumes:
      - hakkurin_data:/app/data
    depends_on:
      sidecar:
        condition: service_healthy

  sidecar:
    image: ghcr.io/hakkayoro/hakkurin-sidecar:latest
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:7654/health')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

volumes:
  hakkurin_data:
```

1. Configura `bot_token`, `gemini_keys` y credenciales Navidrome en
   `data/config.json` (volumen) o desde la WebUI. `webui_token` activa el HTTP
   Basic; sin él la WebUI queda abierta en la red.
2. `docker compose up -d` — no hay pasos manuales: la env fija la URL del sidecar.
3. WebUI en `http://<host>:30421` (escucha en `::`, sobreescribible con `WEBUI_HOST`).

Si el pull de `hakkurin-sidecar` falla con `denied`: GHCR crea los paquetes nuevos
privados por defecto — hazlo público o autentica el NAS.

## Desarrollo

```bash
npm install
npm test            # vitest
npm run start:dev   # watch; requiere sidecar aparte para música YT (http://localhost:7654)
```

Necesita `data/config.json` con `bot_token` y `gemini_keys`, y ffmpeg en el PATH.

## Estructura

```
src/
  ai/            GeminiProvider: ladder de modelos, rotación de keys, web search
  common/        ConfigService (data/config.json, escritura atómica)
  conversation/  historial de canales y sesiones de conversación
  discord/       gateway, pipeline de mensajes, slash commands, loops de fondo
  memory/        cifrado por usuario, resúmenes, self-memory
  music/         split hexagonal: domain/ports + sidecar.client + ffmpeg.adapter + presenter + updater
  navidrome/     cliente Subsonic
  scheduler/     cron de festividades
  web/           WebUI nunjucks, AuthGuard y LogTee (export de logs)
sidecar/         FastAPI + yt-dlp: /extract, /version, /update, /reset
test/            specs de vitest, un archivo por módulo
```

Referencias históricas: el código Python original vive en la rama `legacy-python`;
`docs/` y las guías de agentes IA se conservan en disco, fuera del repo.

## Licencia

Ver [LICENSE](LICENSE).
