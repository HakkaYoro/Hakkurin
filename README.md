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
  como respaldo (40 min de modo fallback). Contexto capado a ~16k tokens, salida del
  LLM validada con **zod** (extracción de JSON tras fences — Gemma no soporta JSON
  mode) y búsqueda web two-pass en los modelos de respaldo.
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
- **Arquitectura hexagonal + DDD** — cada feature se parte en `domain/` (entidades,
  value objects, eventos y puertos como abstract classes), `application/` (use-cases
  sin frameworks) e `infrastructure/` (adaptadores de Discord, voz, ffmpeg, sidecar y
  disco); los eventos de dominio viajan por `@nestjs/event-emitter` y se publican solo
  tras persistir.

## Stack

NestJS 11 · discord.js 14 · @discordjs/voice · @google/genai · @nestjs/event-emitter ·
zod · nunjucks · vitest · AES-256-GCM vía `node:crypto`. Dos imágenes en GHCR: `bot`
(~450 MB, ffmpeg estático) y `sidecar` (~210 MB, python:3.11-slim + yt-dlp).

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
npm test            # vitest (217 specs)
npx tsc --noEmit    # typecheck (no hay script lint)
npm run build       # nest build → dist/ (templates vía nest-cli assets)
npm run start:dev   # watch; requiere sidecar aparte para música YT (http://localhost:7654)
```

Necesita `data/config.json` con `bot_token` y `gemini_keys`, y ffmpeg en el PATH.

## Estructura (hexagonal)

Cada feature se organiza en `domain/` (TypeScript puro: agregados, value objects,
eventos y **puertos** como abstract classes), `application/` (use-cases) e
`infrastructure/` (adaptadores concretos). Los puertos se bindean en el `@Module` con
`{ provide: Puerto, useExisting: Adaptador }`; los use-cases no importan discord.js ni
`fs`.

```
src/
  common/        ConfigService @Global (data/config.json atómico, sidecarUrl())
  ai/            puerto AiBrain; GeminiAdapter (ladder, rotación de keys);
                 mapper zod de la salida del LLM
  memory/        agregado UserMemory, cifrado AES-256-GCM, cola con mutex,
                 listener de eventos para la auto-memoria
  conversation/  entidades Session/ChannelContext, historial de canales
  discord/       gateway + loops de fondo (DiscordAdapter, implementa
                 MessageTransportPort + BotStatePort + BotLifecycle);
                 use-cases puros (respuesta, recordatorios, festividades, DMs)
  music/         GuildMusicState + QueueItemVo; puertos de voz/audio/stream;
                 adaptadores @discordjs/voice, ffmpeg, sidecar yt-dlp, presenter
  navidrome/     SongVo + NavidromeAdapter (cliente Subsonic, CatalogPort)
  scheduler/     parser de recordatorios embebidos en auto-memoria
  web/           WebUI nunjucks, AuthGuard, LogTee (export de logs)
sidecar/         FastAPI + yt-dlp: /extract, /version, /update, /reset
test/            specs de vitest, un archivo por módulo (cwd tmp aislado)
```

Regla de nombrado: **un puerto, un `*.adapter.ts`** — los 15 puertos viven en
`domain/ports/` como abstract classes y cada uno tiene su adaptador en
`infrastructure/`:

| Puerto (`domain/ports/`) | Adaptador (`infrastructure/`) |
|---|---|
| `AiBrain` | `GeminiAdapter` (Gemma + ladder) |
| `EncryptorPort` · `MemoryRepositoryPort` · `MemoryQueuePort` | `CryptoAdapter` · `MemoryRepositoryAdapter` · `MemoryQueueAdapter` |
| `MessageTransportPort` · `BotStatePort` · `BotLifecycle` | `DiscordAdapter` (gateway primario + loops) |
| `HolidayStorePort` · `SleepStorePort` | `HolidayStoreAdapter` · `SleepStoreAdapter` |
| `UrlEnricherPort` | `UrlEnricherAdapter` |
| `StreamSource` | `SidecarAdapter` (sidecar yt-dlp) |
| `AudioPipeline` | `FfmpegAdapter` |
| `MusicPresenter` | `DiscordPresenterAdapter` |
| `VoiceConnectionPort` | `VoiceAdapter` (@discordjs/voice) |
| `CatalogPort` | `NavidromeAdapter` (Subsonic) |

Los adaptadores primarios (entrada, sin puerto que implementar) conservan el
sufijo Nest idiomático: `WebController` (HTTP), `SlashCommandsService` y
`YtdlUpdaterService` (cron horario de yt-dlp).

Referencias históricas: el código Python original vive en la rama `legacy-python`;
`docs/` y las guías de agentes IA se conservan en disco, fuera del repo.

## Licencia

Ver [LICENSE](LICENSE).
