# Hakkurin — Bot de Discord con personalidad (NestJS)

[![Node](https://img.shields.io/badge/Node-22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs)](https://nestjs.com/)
[![AI](https://img.shields.io/badge/AI-Gemma--4--26b-orange?style=flat-square&logo=google)](https://ai.google.dev/)

Hakkurin no es un bot de comandos: es una entidad que "vive" en tu servidor. Escucha,
decide cuándo participar, recuerda quién eres (memoria cifrada por usuario), reproduce
música y puede ignorarte si no le caes bien. Porteado desde Python a **NestJS/TypeScript**;
el original queda en la rama `legacy-python`.

## Características

- **Cerebro Gemma** (Gemma-4-26b primario, Gemini flash de respaldo) — análisis de intención, respuestas contextuales con delays de escritura humanos.
- **Memoria cifrada AES-256-GCM** por usuario + auto-memoria del bot (con recordatorios programados embebidos).
- **Pipeline probabilístico** — mencionan, reply, actividad reciente o probabilidad configurable; debounce abortable si alguien sigue escribiendo.
- **Música** — YouTube (vía sidecar yt-dlp) + Navidrome (Subsonic), `/play /skip /stop /queue /search /radio`, radio con auto-prefetch, desconexión por canal vacío.
- **WebUI** — dashboard server-rendered (neón) para config en vivo, browse de memorias y restart. Secretos write-only, bind localhost.
- **Loops de fondo** — timeouts de sesión, cola de memoria, recovery de API, festividades, recordatorios, limpieza de canales de voz.

## Stack

NestJS 11 · discord.js 14 (directo) · @discordjs/voice · @google/genai · nunjucks · AES-256-GCM vía `node:crypto`. Voice usa ffmpeg; YouTube se resuelve con un sidecar Python yt-dlp.

## Arranque rápido (Docker)

```bash
cp data/config.json.example data/config.json   # edita bot_token, gemini_keys, navidrome_*
docker compose up -d --build
# WebUI en http://localhost:30421  (setea WEBUI_HOST=0.0.0.0 + webui_token para exponer)
```

El compose levanta `bot` (NestJS, `:30421→8000`) y `sidecar` (yt-dlp, interno
`http://sidecar:7654`). Setea `ytdl_sidecar_url: "http://sidecar:7654"` en la WebUI.

## Desarrollo

```bash
npm install
npm test            # jest
npm run start:dev   # watch (necesitas el sidecar corriendo aparte para música YT)
```

Requiere `data/config.json` con `bot_token` y `gemini_keys`. ffmpeg en el PATH para voz.

## Estructura

Ver [`CLAUDE.md`](CLAUDE.md) (guía autoritativa del código) y [`docs/`](docs/) (referencia
del Python original + plan del port). En resumen: `src/{ai,memory,conversation,discord,music,navidrome,scheduler,web,common}` + `sidecar/`.

## Licencia

Ver [LICENSE](LICENSE).
