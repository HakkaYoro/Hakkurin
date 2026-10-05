# CLAUDE.md — Hakkurin (NestJS)

Guía autoritativa del runtime **NestJS/TypeScript** para agentes de IA (Claude Code y
otros). `docs/` describe el Python original + la racional del port; **este archivo es
la fuente de verdad del código actual**. Si `docs/` y este archivo discrepan, cree a este.

## Qué es

Hakkurin es un bot de Discord con personalidad (e-girl/otaku) que "vive" en un servidor:
escucha, decide cuándo participar (pipeline probabilístico), tiene memoria cifrada por
usuario, IA con Gemma primario, música (YouTube + Navidrome), recordatorios embebidos en
su auto-memoria, y una WebUI para config en vivo.

Porteado desde Python (~3700 líneas discord.py + FastAPI) a **NestJS 11**. El Python
original vive en la rama `legacy-python`.

## Stack

- **NestJS 11** (DI, módulos `@Global`), `@nestjs/schedule` para los loops `@Interval`.
- **discord.js 14 DIRECTO** (sin necord): el pipeline necesita control imperativo del
  Client (cancelación por typing vía `AbortController`, debounce abortable) y el
  `POST /restart` del WebUI destruye+recrea el cliente.
- **@discordjs/voice** (ffmpeg → PCM s16le 48k stereo, `inlineVolume` 0.5):
  - `opusscript` (fallback JS puro para Opus)
  - `libsodium-wrappers` (WASM para Sodium)
  - `@snazzah/davey`, `@noble/ciphers`, `@stablelib/xchacha20poly1305` (Requerido para encriptación de voz de Discord DAVE E2EE)
- **@google/genai** — **Gemma-4-26b primario**, Gemini flash de respaldo. Sin NanoGPT.
- **nunjucks** server-rendered para la WebUI. AES-256-GCM vía `node:crypto`.

## Comandos

```bash
npm test              # vitest (194 tests; cwd tmp aislado por archivo vía test/_setup.ts)
npm run build         # nest build → dist/ (copia templates vía nest-cli assets)
npm run start:prod    # node dist/main.js
npm run start:dev     # watch
docker compose up -d --build   # bot (:30421→8000) + sidecar yt-dlp
```

## Layout

```
src/
  main.ts                # bootstrap; bind 127.0.0.1 (WEBUI_HOST para exponer)
  app.module.ts          # ScheduleModule.forRoot() + todos los feature modules
  common/                # ConfigService (data/config.json atómico) + util.ts — @Global
  ai/                    # GeminiProvider (motor retry/keys) + ai-prompts + key-rotation
                         # + context-builder (arma el prompt; desacopla ai→memory)
  memory/                # MemoryService (política) + memory.repository (AES-256-GCM)
                         # + memory.queue (cola con dedupe, promoción inyectada)
  conversation/          # Session + ChannelContext, active users, timeouts
  discord/               # DiscordService (gateway+scheduler @Interval) + use-cases:
                         # smart-response, reminder, holiday, music-ui + StealthDm/Sleep
  music/                 # MusicService (casos de uso+voz) + domain/ports puros +
                         # sidecar.client + ffmpeg.adapter + presenter + ytdl-updater
  navidrome/             # Subsonic REST, auth MD5-salt
  scheduler/             # ActionParserService (parser fenced-JSON de recordatorios)
  web/                   # WebController (via puerto BotLifecycle) + ViewService + AuthGuard
  web/templates/         # _base.html + index/memories/memory_view (CSS neón)
sidecar/                 # extract_server.py — yt-dlp HTTP: /extract, /version,
                         # /update (pip -U + exit → compose reinicia), /reset (kill)
test/                    # vitest (NO confundir con tests/ legacy, borrado)
data/                    # config.json (SECRETS, gitignored), memory/, holidays.json, status_messages.json
```

## Arquitectura clave

- **`DiscordService`** (`src/discord/discord.service.ts`) es el gateway + scheduler:
  aloja los **6 loops `@Interval(60000)`** con guard de reentrada (`@Interval` NO es
  secuencial como `@tasks.loop`). Los use-cases viven delegados: `SmartResponseService`
  (pipeline de mensajes: debounce 5s abortable, espera typing, send con delays de
  escritura), `ReminderService` (dedupe en memoria), `HolidayService` (calendario
  GMT-4 + dedupe por archivo).
- **`AiBrain`** (`@Inject('AiBrain')`): `analyzeInteraction` (decide intent:
  reply/complain/new_topic/ignore/error), `generateResponse`, `generateSummary`,
  `generateHolidayGreeting`, `testApiConnection`, `reloadConfig`. Gemma no soporta JSON
  mode nativo → parseo defensivo tras fences.
- **`MemoryService`**: `.enc` por usuario (AES-256-GCM), `BOT_SELF_ID` para auto-memoria,
  cola temporal con dedupe, espejo plano en `data/memory/summaries/`.
- **Sidecar yt-dlp**: el bot resuelve YouTube con `GET {ytdl_sidecar_url}/extract?url=`
  (default `http://localhost:7654`, `http://sidecar:7654` en compose). No descarga, sólo
  extrae la URL directa de stream; ffmpeg corre del lado de @discordjs/voice.
- **Auto-update de yt-dlp**: `YtdlUpdaterService` (`src/music/ytdl-updater.service.ts`)
  corre cada hora; solo actualiza si `MusicService.isIdle()` (nadie reproduce ni
  extrae). Consulta `GET /version` (instalada vs PyPI) y con diferencias hace
  `POST /update`: el sidecar hace `pip install -U yt-dlp` y se mata a sí mismo
  (`os._exit` diferido) → compose `restart: unless-stopped` lo levanta fresco, sin
  re-buildear la imagen. Si suena algo, el propio intervalo re-verifica en 1h.
- **/stop hard-kill**: `resetPlaybackState` incrementa `epoch` por guild y aborta el
  `AbortController` del extract; `playNext` verifica el epoch tras CADA await
  (fetch 20s + prebuffer 5s) → un /stop no deja ffmpeg zombie ni player colgado.
  /stop además hace `POST /reset` al sidecar (mata el proceso yt-dlp wedged;
  compose lo reinicia en ~2s) y `SidecarClient` reintenta el extract una vez ante
  ECONNREFUSED para cubrir ese hueco.

## Reglas de seguridad (NO romper)

- **Nunca loguear** URLs de stream/cover de Navidrome (embedean `u/t/s`), ni contenido de
  DMs fuera del flag `debug_dm`, ni la password/token. Los secrets viven en
  `data/config.json` (gitignored, escritura atómica).
- **WebUI**: secretos write-only (bot_token, gemini_keys, navidrome_password) NUNCA se
  hacen echo al DOM; bind localhost por defecto; auth HTTP Basic opt-in vía `webui_token`.
- `data/memory/secret.key` es 0600, gitignored.

## Convenciones de trabajo

- **Responde al usuario en español.**
- **Modo Ponytail**: marca simplificaciones deliberadas con comentarios `ponytail:` (nombran
  el techo y el upgrade path). Stdlib antes que deps. El código más corto que funcione.
- Patron por feature: escribir → revisión adversarial (Sonnet) contra el fuente relevante →
  corregir → `npx tsc --noEmit` + `npm test` (vitest).
- La verify de voz/sidecar/Navidrome/Discord es **en vivo** (servidor real), no headless.

## Config (`data/config.json`)

Claves: `bot_token`, `gemini_keys[]`, `bot_name`, `system_prompt`, `reply_probability`,
`developer_id`, `allowed_channels[]`, `navidrome_{base_url,external_url,username,password}`,
`ytdl_sidecar_url`, `webui_token`, `debug_dm`. Editable vía WebUI o JSON directo; `POST /restart` aplica.
