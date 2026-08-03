# 03 — NestJS Port Plan

Concrete plan to rewrite Hakkurin from Python (`discord.py` + FastAPI) to NestJS (TypeScript). Companion to `00-overview.md`, `01-architecture.md`, `02-ai-system.md`, `04-data-security.md`. All `file:line` refs are to the current Python tree unless noted.

> **NOTA DE ESTADO (2026-08-03):** Las secciones `1`–`7` de abajo son el **plan original** (escrito antes de
> codear). El **estado real actual** vive en la sección `0` inmediatamente debajo, y en `CLAUDE.md` (fuente de
> verdad del código). Si el plan y la sección `0` discrepan, cree a la sección `0`.

---

## 0. Estado actual del port (lo que está hecho y lo que FALTA)

El runtime NestJS/TypeScript **está implementado** (fases 1–6 + parte de la 7). Verificación offline verde:
`npx tsc --noEmit` OK, `npx jest` → **61/61 tests**. Lo que queda es **publicar + verificar en vivo** + cerrar
gaps del WebUI.

### 0.1 Hecho ✅

- **Scaffold** NestJS 11, `ConfigService` (`data/config.json`, escritura atómica temp+rename), `MemoryService`
  + `CryptoService` (AES-256-GCM por usuario, `BOT_SELF_ID`, cola con dedupe, espejo plano en
  `data/memory/summaries/`).
- **AiModule**: `AiBrain` interface + `GeminiProvider` con **Gemma-4-26b primario**, Gemini flash fallback,
  **sin NanoGPT**. Rotación de keys, RPM/RPD, parseo defensivo de JSON tras fences (Gemma no soporta JSON mode).
- **DiscordModule**: `DiscordService` (hub + pipeline: debounce 5s abortable vía `AbortController`,
  typing-await 8s, send con delays de escritura), `StealthDmService`, `SleepService`, `SlashCommands`.
- **Music + Navidrome + sidecar**: `MusicService` por guild (`@discordjs/voice`, `inlineVolume` 0.5),
  `NavidromeService` (Subsonic REST, MD5-salt), sidecar `sidecar/extract_server.py` (yt-dlp HTTP `/extract?url=`).
- **WebModule**: dashboard, `POST /update_config`, `POST /restart`, `GET /memories`, `GET /memories/:user_id`,
  `AuthGuard` (Basic opt-in), nunjucks con CSS neón, secretos write-only.
- **Scheduler**: `ActionParserService` (puerto de `core/scheduler.py`) + **6 loops `@Interval(60000)`** alojados
  en `DiscordService` (no existe un `SchedulerModule` separado — eliminado por YAGNI).
- **Cutover parcial**: `Dockerfile` 2-stage (Node+ffmpeg, sin libsodium), `sidecar/Dockerfile`, `docker-compose.yml`
  (`:30421→8000`, volumen, sidecar interno), `nest-cli.json` (assets templates), `.dockerignore`, `CLAUDE.md`,
  `README.md`, CI `.github/workflows/docker-publish.yml` scoped **solo a `main`**, `data/config.json.example`.

### 0.2 Decisiones del port que DIFIEREN del plan original (1–7)

- **`necord` eliminado** → discord.js 14 **directo**. Motivo: el pipeline necesita control imperativo del Client
  (cancelación por typing vía `AbortController`, debounce abortable) y el `POST /restart` destruye+recrea el cliente.
- **`SchedulerModule` eliminado** → los 6 loops viven en `DiscordService` con guards de reentrada (`@Interval`
  no es secuancial como `@tasks.loop` de discord.py).
- **Migración Fernet cancelada** → wipe de memoria. La key AES-256-GCM se genera on-first-run. No hay script
  Fernet→AES (decisión locked del usuario: empezar de cero).
- **Navidrome creds en `data/config.json`** (no `.env`), scrub del password del historial via `git-filter-repo`.

### 0.3 FALTA por hacer ❌ (handoff para la próxima sesión)

1. **Publicar al remote** — el `force-push` a `main` está bloqueado por el clasificador de auto-mode del agente
   (detecta "destructive history rewrite"). Lo debe ejecutar el usuario con `!` (ver §0.4). El local ya está listo:
   `main` es orphan limpio (solo NestJS), `legacy-python` tiene el Python scrubbeado, `nestjs-port` borrado.
2. **Verificación EN VIVO en servidor real** ⚠️ **LO MÁS IMPORTANTE** — las fases 3 y 4 decían "verify in a
   test server" y **nunca se hizo** (solo tsc + jest). Cosas que sólo saltan en runtime y hay que probar:
   - Pipeline real: mention → typing-await → respuesta con delays; mensaje nuevo dentro de 5s cancela el pendiente.
   - Stealth DM: `[MD:id]` en una respuesta llega ~3s después como DM.
   - **Voice**: `/play <url>` (sidecar real + ffmpeg + `@discordjs/voice`), voto-skip, `/radio` prefetch, desconexión
     por canal vacío a 300s. Riesgos del plan: bug "audio 2x" al conectar, paridad de volumen `0.5`.
   - **Navidrome real**: search, buttons Components V2, stream/cover (NUNCA loguear las URLs con u/t/s).
   - **Gemma real respondiendo**: que el modelo primario efectivamente contesta y el fallback Gemini entra al agotar keys.
   - `intent:'error'` (agotar todas las keys) → sleep mode, status dnd, recovery probe cada 60s.
   - Recordatorio programado vía auto-memoria → dispara en ventana de 10 min y dedupea tras restart.
3. **Re-verify del compose**: `docker compose up -d --build` levanta `bot` + `sidecar`, WebUI en `:30421`.
4. **Gaps del WebUI** (pregunta del usuario — ver §0.5 para detalle): `allowed_channels`, `debug_dm`, y edición
   de memorias NO están hoy en la WebUI.

### 0.4 Comandos para publicar al remote (ejecutar con `!` en la sesión)

El clasificador bloquea que el agente haga `git push --force`. El usuario los corre con prefijo `!`:

```
! git push --force origin main            # publica el NestJS limpio (sobreescribe el main remoto con password)
! git push origin legacy-python           # publica el Python scrubbeado como rama legacy
! git push origin --delete nestjs-port    # borra la rama remota vieja (aún contiene el password)
```

Tras eso, el password `N2Iiaq.d20l9eoJE` ya no vive en ningún ref del remote. Verificar:
`! git ls-remote --heads origin` (debe listar solo `main` y `legacy-python`).

### 0.5 ¿Qué es editable / visible desde la WebUI? (pregunta del usuario)

**SÍ editable** vía `POST /update_config` (`src/web/web.controller.ts`): `bot_name`, `system_prompt`,
`reply_probability`, `developer_id`, `navidrome_{base_url,external_url,username,password}`,
`ytdl_sidecar_url`, `bot_token` (write-only), `gemini_keys` (write-only, multiline).

**NO editable** hoy (gap — la próxima sesión decide si añadirlos):
- `allowed_channels[]` — array, el form no lo maneja. Editar directo en `data/config.json`.
- `debug_dm` (bool) — flag de log de DMs, no está en el form.
- `webui_token` — es el token que protege el propio form (problema huevo-gallina); si se pierde, se edita en JSON.

**Memorias** — `GET /memories` lista (`.enc` por mtime, marca self) y `GET /memories/:user_id` muestra el
resumen descifrado. **Son SOLO LECTURA**: no hay edición ni borrado desde la WebUI. Si se quiere editar/borrar
memorias desde el dashboard, es trabajo nuevo (añadir `POST /memories/:user_id` + form).

### 0.6 Cómo arrancar la próxima sesión

1. `git pull` / confirmar que `main` y `legacy-python` están publicados.
2. `cp data/config.json.example data/config.json`, rellenar `bot_token` + `gemini_keys` + `navidrome_*`.
3. Levantar el sidecar: `cd sidecar && pip install -r requirements.txt && uvicorn extract_server:app --port 7654`.
4. `npm run start:dev` y probar el pipeline real contra un servidor de prueba (§0.3 punto 2).
5. La fuente de verdad del código es `CLAUDE.md`, no este doc. Restricciones permanentes del usuario: **responder
   en español**, **Gemma-4-26b primario**, **subagentes Sonnet/Haiku cuando aporten valor**, **Ponytail ultra**
   (YAGNI extremista, stdlib primero).

### 0.7 Bugs cazados en el primer arranque en vivo (2026-08-03)

Registro de lo que saltó al correr Hakkurin por primera vez en un servidor real (todo lo de §0.3 era
"verificar en vivo" — esto es el resultado parcial de esa verificación).

- ✅ **FIXED — Intent de voz faltante.** Síntoma: `/play` respondía "¡Necesitas estar en un canal de voz…"
  aunque el usuario estuviera en un VC. Causa: el `Client` declaraba 7 intents pero **no `GuildVoiceStates`**
  → `member.voice.channel` siempre era `null`. Fix: una línea en `src/discord/discord.service.ts` (añadir
  `GatewayIntentBits.GuildVoiceStates`). La lógica de join de `MusicService` estaba bien.
- ⏳ **PENDIENTE — verificar el resto de voz en vivo.** Tras el fix del intent, queda por probar en un guild
  real: `/play <url>` (sidecar + ffmpeg + `@discordjs/voice`), voto-skip, `/radio` prefetch, desconexión por
  canal vacío a 300s. Riesgos heredados del plan: bug "audio 2x" al conectar, paridad de volumen `inlineVolume:0.5`.
- ✅ **Confirmado funcionando:** login del bot, registro de slash commands, pipeline de mensajes completo
  (trigger → debounce → `analyzeInteraction` Gemma → respuesta con delays), auto-memoria (`Resumen de memoria
  actualizado para hakkurin_internal_self`), `POST /restart` (destruye+recarga config+recrea cliente).
- ⚠️ **Observado:** al arrancar sale `[GeminiProvider] No hay API Keys de Gemini configuradas.` hasta el primer
  `restart`/reload — las keys sí estaban en config (6 keys); revisar el orden de carga (config se lee antes de que
  `reloadConfig` las levante). No bloqueante: tras restart funciona.

---

## 1. Target NestJS module structure

Proposed `src/` layout. Each module owns one responsibility; the first line is the source it replaces.

```
src/
  main.ts                     # Bootstrap: AppModule, ConfigModule, @nestjs/platform-express
  app.module.ts               # Imports all feature modules (see wiring below)
  config/
    config.module.ts          # @nestjs/config (ConfigModule.forRoot global) over .env
  discord/
    discord.module.ts         # Gateway lifecycle
    discord.service.ts        # discord.js Client, onMessage/onTyping/onReady handlers
    slash.commands.ts         # necord @Slash() command registration (play/skip/stop/queue/search/radio)
    message.pipeline.ts       # trigger decision, debounce, typing-await, response send, stealth DM
    stealth-dm.service.ts     # [MD] parsing, strip, 3s-delayed send, target resolution
  ai/
    ai.module.ts              # Provides AiBrain provider (Gemini-only)
    ai-brain.interface.ts     # Contract consumed by Discord layer (section 4)
    gemini.provider.ts        # @google/genai client, key rotation, rate limits, web_search tool
  memory/
    memory.module.ts          # Exports MemoryService
    memory.service.ts         # AES-256-GCM encrypted per-user .enc, schema normalize, queue
    crypto.service.ts         # Node crypto AES-256-GCM wrapper + Fernet migration helper
    summary.service.ts        # Buffer/summary update, plaintext mirror
  conversation/
    conversation.module.ts
    conversation.service.ts   # Session, ChannelContext, active users, timeouts
  music/
    music.module.ts
    music.service.ts          # Queue, playback, radio, vote-skip, play-history, empty-VC cleanup
  navidrome/
    navidrome.module.ts
    navidrome.service.ts      # Subsonic REST client (axios/fetch), MD5-salt auth
    navidrome-ui.service.ts   # Search result views -> discord.js action rows + buttons
  web/
    web.module.ts             # NestJS controllers replacing FastAPI WebUI
    config.controller.ts      # GET / (dashboard), POST /update_config, POST /restart
    memories.controller.ts    # GET /memories, GET /memories/:user_id
  scheduler/
    scheduler.module.ts       # @nestjs/schedule cron/interval jobs (6 loops)
    scheduler.service.ts      # Scheduled-actions parser/dedupe (JSON-in-memory)
```

### Module responsibilities vs Python source

| NestJS module | Replaces | Responsibility | Key source refs |
|---|---|---|---|
| `ConfigModule` | `core/config_manager.py` + `python-dotenv` | Load env vars + `.env`; replace `data/config.json` reads. Config is typed + injectable, no global singleton. | `core/config_manager.py:4-47` (singleton + JSON persistence), `main.py:26` (`load_dotenv`) |
| `DiscordModule` | `bot/discord_client.py` | Gateway client, intents, `onReady`/`onTyping`/`onMessage`, slash-command tree, message pipeline, debounce, stealth DM, bot status/presence. | `bot/discord_client.py:13-19` (client + intents), `:237-240` (on_ready), `:252-276` (on_typing), `:306-401` (on_message), `:403-432` (debounce), `:434-777` (pipeline) |
| `AiModule` | `core/ai_handler.py` | Gemini-only provider behind `AiBrain`. Key rotation, RPM/RPD limits, fallback model order, `web_search` tool, `generate_summary`, `generate_holiday_greeting`, `test_api_connection`. NanoGPT path is dropped (see `02-ai-system.md`). | `core/ai_handler.py:14-45` (KeyUsage), `:96-132` (key init/rotation), `:352-491` (retry/fallback), `:493-664` (analyze_interaction), `:710-830` (generate_summary) |
| `MemoryModule` | `core/memory_manager.py` | Per-user encrypted memory, schema normalize, interaction buffer, temp queue, `BOT_SELF_ID`, plaintext summary mirror. | `core/memory_manager.py:10-16` (constants), `:118-161` (get/save/schema), `:163-183` (add_interaction), `:205-217` (self memory), `:352-438` (queue) |
| `ConversationModule` | `core/conversation_manager.py` + typing state | Sessions per `(channel,user)`, per-channel context, 1h message history, image buffer, active-user window, session timeouts. | `core/conversation_manager.py:9-38` (Session), `:40-82` (ChannelContext), `:107-139` (create session/active users), `:147-202` (check_timeouts) |
| `MusicModule` | `bot/music_manager.py` | Queue, playback via `@discordjs/voice`, vote-skip, radio auto-queue, play history, empty-VC cleanup. | `bot/music_manager.py:87-101` (state dicts), `:105-130` (empty-VC), `:164-258` (play_next), `:260-313` (radio), `:360-414` (skip/stop) |
| `NavidromeModule` | `bot/navidrome_client.py` + `bot/navidrome_ui.py` | Subsonic REST client + UI views (buttons → play/radio). KEEP MD5-salt auth. | `bot/navidrome_client.py:22-32` (auth), `:34-141` (endpoints), `bot/navidrome_ui.py:4-95` (View/buttons), `:97-121` (embed) |
| `WebModule` | `web/app.py` (FastAPI) | Config dashboard, config edit form, restart endpoint, memories list/view. | `web/app.py:14-18` (root), `:26-57` (restart + update_config), `:61-108` (memories) |
| `SchedulerModule` | `discord.ext.tasks` loops + `core/scheduler.py` | The 6 background loops + scheduled-actions parser/dedupe. | loops at `discord_client.py:104,278,841,899,918` and `music_manager.py:105`; parser at `core/scheduler.py:124-207` |

### `AppModule` wiring

```ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DiscordModule,
    AiModule,
    MemoryModule,
    ConversationModule,
    MusicModule,          // imports NavidromeModule
    NavidromeModule,
    WebModule,
    SchedulerModule,      // imports DiscordModule + MemoryModule (runs the 6 loops)
  ],
})
export class AppModule {}
```

Notes:
- `MemoryModule`, `ConversationModule`, `AiModule` export services consumed by `DiscordModule` and `SchedulerModule`. Use a global module or explicit imports (prefer explicit imports).
- `MusicModule` and `NavidromeModule`: `MusicService` depends on `NavidromeService`; `NavidromeUiService` depends on both.
- `DiscordModule` must expose the raw `Client` (or a wrapper) so `SchedulerModule`/`MusicModule` can resolve guilds, channels, and users.
- `ConfigService` replaces every `config.get(...)` call site (e.g. `discord_client.py:310` allowed channels, `:366` reply_probability, `:753` bot_name).

---

## 2. Framework / library mapping

| Python (current) | NestJS / TS (target) | Notes |
|---|---|---|
| `discord.py` `Client` + `app_commands.CommandTree` | `discord.js` + `necord` | Current code uses raw `discord.Client` (not `commands.Bot`); slash commands registered inline in `__init__` (`discord_client.py:39-83`) and synced in `setup_hook` (`:85-88`). necord `@Slash()` decorators + `@On('messageCreate')` event handlers replace both. Keep inline registration equivalent; sync via `applicationCommands` in `onReady`. |
| `discord.ext.tasks` `@tasks.loop` | `@nestjs/schedule` `@Interval()` / `@Cron()` | 6 loops: `check_reminders_task` `discord_client.py:104` (1 min), `check_timeouts_task` `:278` (60 s), `recovery_check_task` `:841` (60 s), `process_memory_queue_task` `:899` (60 s), `check_holidays_task` `:918` (60 s), `check_empty_voice_channels` `music_manager.py:105` (1 min). `before_loop` hooks (`wait_until_ready`) become `OnModuleInit` awaiting `client.isReady()`. |
| `discord.ui.View` / `Button` | discord.js Components V2 (action rows + buttons) | `QueueView` `music_manager.py:61-85` (clear-queue button), `NavidromeSearchView` `navidrome_ui.py:4-95` (dynamic song/album/artist buttons with `custom_id` = `song_{idx}`, rows 0-2). Use `MessageComponentCollector` or necord `@Component` handlers; disable buttons after use (`navidrome_ui.py:87-95`, `music_manager.py:80-84`). |
| `FFmpegPCMAudio` + `yt-dlp` | `@discordjs/voice` (`AudioPlayer`, `createAudioResource`) + `play-dl` or `ytdl-core` | `YTDLSource` `music_manager.py:30-59`, `ffmpeg_options` `:23-26`. `AudioPlayer` idle/failed state events REPLACE the hand-rolled `is_fetching` flag (`music_manager.py:167-173,255-258`) and the `after=` recursion (`:236` → `play_next`). Reconnect flags map to `createAudioResource(input, { inlineVolume: true })`; volume transformer is `VolumeTransformer` instead of `PCMVolumeTransformer` (`music_manager.py:30,210`). |
| Navidrome `aiohttp` client | NestJS `HttpService` (axios) or native `fetch` | `navidrome_client.py:17-20` session, `:34-141` endpoints (`search3`, `getSimilarSongs2`, `getRandomSongs`, `getAlbum`, `stream`, `getCoverArt`). **KEEP MD5-salt auth**: `token = md5(password + salt)` with random 6-char alnum salt (`:22-32`). |
| FastAPI + Jinja2 WebUI | NestJS controllers + template engine (or static HTML served by NestJS) | `web/app.py:9-108`. Routes: `/` index, `/restart`, `/update_config` (form POST), `/memories`, `/memories/{user_id}`. Port 8000 (`:111`). Keep same routes; render via a TS template engine or serve prebuilt static HTML. |
| Fernet encryption (`cryptography`) | Node `crypto` AES-256-GCM (or Prisma + DB with encrypted column) | `memory_manager.py:4,18-21` (key file `data/memory/secret.key`, `Fernet` cipher), `:124-141` (encrypt/decrypt on read/write), `:38-48` atomic writes. See `04-data-security.md`. |
| `python-dotenv` + `data/config.json` | `@nestjs/config` loading `.env` | `config_manager.py:4-47` (JSON persistence + singleton `config`), `main.py:26`. Replace both with env vars; keep same keys (`bot_token`, `bot_name`, `system_prompt`, `reply_probability`, `developer_id`, `gemini_keys`, `allowed_channels`). |
| `google-genai` SDK | `@google/genai` TS SDK | Gemini-only per `02-ai-system.md`. `ai_handler.py:5-6` imports, `:112` `genai.Client(api_key=...)`, `:428-433` `models.generate_content`, `:633-638` `GenerateContentConfig(response_mime_type="application/json")`. |
| `ddgs` (DuckDuckGo search) | A DDG JS lib or direct fetch | `web_search` tool must be kept. `ai_handler.py:148-189` (`_search_ddg`, region `ve-es`, max 5 results, query shortening fallback), tool-call loop `:285-307`. |
| `cryptography` Fernet | Node `crypto` AES-256-GCM | Same row as Fernet above. |
| `asyncio` tasks / `create_task` | `setTimeout`-wrapped promise / JS promises | Debounce `discord_client.py:400-432`, delayed DMs `:744-749`, status `create_task` calls `:376,396,762,768`. Use `AbortController` or cancellation token for task-cancel semantics (`:263-271,384-392`). |
| `random` human delays | `setTimeout` + `Math.random()` | Typing delay `discord_client.py:663,714-715` (`len*0.08` clamped 0.5-4 s), callback delay `:301`, inter-message gap `:741`, holiday spacing `:988`. |

---

## 3. Stealth DM port

Python source: `bot/discord_client.py:694-749` (extract + strip + delayed send) and `:779-801` (`send_stealth_dm`).

### Regex (ports 1:1)

```py
# discord_client.py:696  — extract pass (also used with IGNORECASE | DOTALL)
r'\[MD:(\d+)\](.*?)(?:\[/MD\]|/MD\]|\[/MD|$)'
# discord_client.py:704  — strip pass
r'\[MD:\d+\].*?(?:\[/MD\]|/MD\]|\[/MD|$)'
```

TS equivalent (same alternation, case-insensitive):

```ts
const MD_EXTRACT = /\[MD:(\d+)\](.*?)(?:\[\/MD\]|\/MD\]|\[\/MD|$)/gims;
const MD_STRIP   = /\[MD:\d+\].*?(?:\[\/MD\]|\/MD\]|\[\/MD|$)/gims;
```

- `i` covers the Python `re.IGNORECASE`; `s` covers `re.DOTALL`; `g` for the `finditer`/`sub`-all semantics.
- The closing-tag alternation explicitly tolerates malformed closers (`[/MD]`, `/MD]`, `[/MD`, or end-of-string) — the `3c16475` behavior must be preserved.

### Behavior to replicate

1. **Extract**: iterate all matches on each `response_content` segment; collect `(target_uid, dm_msg)` pairs into `pending_dms` (`:696-701`).
2. **Strip**: remove tags from the segment before the public send (`:704`). If nothing remains, skip the segment entirely (`:707-708`).
3. **Pings**: `ping_users` are prefixed to the *first* public segment only (`:710-712`).
4. **Public send** goes first (with typing indicator + `reference`, `:717-731`).
5. **Delayed DM**: after the public reply, wait 3 s, then send each pending DM (`:743-749`):
   ```ts
   setTimeout(() => { for (const [uid, msg] of pending) await sendStealthDm(msg, uid); }, 3000);
   ```

### Target resolution (`send_stealth_dm`, `:779-801`)

1. If a guild context exists: `guild.get_member(uid)`; if absent, `await guild.fetch_member(uid)` (`:783-789`). In discord.js this is `guild.members.cache.get(uid)` then `await guild.members.fetch(uid)`.
2. If still unresolved (or DM context): `await client.users.fetch(uid)` (`:792-793`).
3. Send: `target.send(dm_msg)` (`:795-796`).
4. Error handling:
   - `discord.Forbidden` → log "[MD OCULTO] 403 ... usuario cerró sus DMs" and drop (`:798-799`). In discord.js catch `DiscordAPIError`/`code: 50013` (or `error.code === 50013`/`'FORBIDDEN'`).
   - Any other exception → log and drop, never throw into the message pipeline (`:800-801`).

---

## 4. Preserved AI contract (interface)

The Discord layer depends ONLY on this interface. The Gemini provider must reproduce the current Python return shapes exactly (see `01-architecture.md`, `02-ai-system.md`). `analyze_interaction` kwargs map from `discord_client.py:594-606`; the JSON schema enforced in the prompt is at `ai_handler.py:605-612`.

```ts
interface InteractionContext {
  userText: string;
  userId: string;
  userName: string;
  contextMessages: string[];          // channel_history, formatted "Name (ID: 123): msg"
  isSessionActive: boolean;
  imageData?: Buffer | Uint8Array;    // attachment / thumbnail bytes
  imageMimeType?: string;
  activeUserIds?: string[];           // 20-min active window + mentions
  isDm: boolean;
  currentPlaying?: string | null;     // "title | Álbum: album" or null
  urlContext?: string | null;         // oEmbed/yt-dlp/HMTL metadata
}

interface AnalysisResult {
  intent: 'reply' | 'ignore' | 'complain' | 'new_topic' | 'error';
  response_content: string[];         // NOTE: Python returns a LIST (may arrive as str; discord_client.py:620-654 normalizes to array). TS interface uses string[].
  is_talking_to_me: boolean;
  thought_process?: string;           // in prompt schema, not consumed downstream
  reply_to_message_id?: string | null;
  ping_users: string[];
}

interface AiBrain {
  analyzeInteraction(ctx: InteractionContext): Promise<AnalysisResult>;
  generateResponse(prompt: string, userContextId?: string, userName?: string): Promise<string | null>;
  generateSummary(currentSummary: string, recentInteractions: string[], userId: string, modelName?: string): Promise<string | null>;
  generateHolidayGreeting(userSummary: string, holidayName: string): Promise<string>;
  testApiConnection(): Promise<boolean>;
}
```

Porting notes:
- Python `response_content` is documented as a list (`:609`, prompt `:609`) but the model sometimes returns a string; `discord_client.py:620-654` normalizes via `ast.literal_eval` with a second cleanup pass. The provider should return `string[]`; the Discord pipeline should keep a cheap defensive normalize (string → single-element array).
- `intent === 'error'` triggers emergency sleep mode (`discord_client.py:774-777`) — the TS switch must keep this branch.
- `generate_response` (`ai_handler.py:846-853`) is used by the reminders loop (`discord_client.py:187`); keep it in the interface.
- `test_api_connection` (`ai_handler.py:832-844`) is used by `recovery_check_task` (`:851`).

---

## 5. Phased migration steps

Each phase is shippable and independently verifiable. Order minimizes risk: config+memory first (no network), then AI, then Discord, then music, then web, then jobs.

### Phase 1 — Scaffold + Config + Memory
- Scaffold NestJS app (`@nestjs/cli`), add `@nestjs/config`, `@nestjs/schedule`, `discord.js`, `necord`, `@discordjs/voice`.
- `ConfigModule`: move every `config.get(...)` key to env vars. Ship `.env.example`.
- `MemoryModule`: port `memory_manager.py` schema, buffer, queue, `BOT_SELF_ID` (`memory_manager.py:206`). Replace Fernet with Node `crypto` AES-256-GCM (`04-data-security.md`).
- **Fernet migration**: existing `data/memory/users/*.enc` and `data/memory/secret.key` are Fernet, not raw AES. Write a one-shot Python decryptor (`scripts/migrate_fernet.py`) that reads the Fernet key, decrypts each `.enc`, re-encrypts AES-256-GCM, and writes the new key. Do not hand-roll AES over Fernet ciphertext.
- Verify: `MemoryService.getMemory/putMemory` round-trips a user memory; migration script converts a fixture `.enc`; queue add/dedupe/process works (`memory_manager.py:382-438`).

### Phase 2 — AiModule
- Gemini-only provider behind `AiBrain` (`section 4`). Drop NanoGPT branch (`ai_handler.py:191-339,646-656`).
- Port: key rotation + RPM(5)/RPD(20) limits (`:11-45,126-132`), model priority + 40-min fallback mode (`:352-491`), `web_search` tool with `_search_ddg` port (`:148-189,285-307`), image bytes via `Part.from_bytes` (`:641-643`).
- Verify: call `analyzeInteraction` offline against a fixture interaction; assert the `AnalysisResult` shape and an `intent: 'error'` path on quota exhaustion.

### Phase 3 — DiscordModule
- Gateway client with intents (`discord_client.py:15-19`): `message_content`, `guilds`, `members`.
- Handlers: `onReady` (`:237-240`), `onTyping` (`:252-276`), `onMessage` (`:306-401`).
- Message pipeline: trigger decision (`:352-369`), immediate memory save (`:396`), 5 s debounce + typing-await up to 8 s + cancel (`:403-432`), session activate + status (`:371-376`), response send with `reference`/pings/typing delays (`:660-741`), stealth DM (`section 3`), channel-context update + self-memory log (`:751-768`).
- Slash commands via necord: `/play` `:39-42`, `/skip` `:44-46`, `/stop` `:48-50`, `/queue` `:52-54`, `/search` `:60-70`, `/radio` `:72-83`. Keep `!sync` debug command (`:319-329`).
- Verify: bot responds in a test server; debounce cancels on new message; stealth DM arrives ~3 s after the public reply; `[DM INPUT]/[DM OUTPUT]` logs are gated (see security).

### Phase 4 — MusicModule + NavidromeModule
- `NavidromeService`: port `search`, `getArtistRadio`, `getSimilarSongs2`, `getRandomSongs`, `getAlbum`, `getStreamUrl`, `getCoverUrl` with MD5-salt auth (`navidrome_client.py:34-141`).
- `MusicService`: queue state per guild (`music_manager.py:91-100`), join/move voice (`:137-162`), `playNext` driven by `AudioPlayer` idle/failed events (replaces `is_fetching` + `after=` recursion `:164-258`), radio auto-queue (`:260-313`), vote-skip (`:360-394`), stop (`:396-414`), queue embed + clear button (`:416-447`).
- Navidrome UI buttons (Components V2) for song/album/artist rows (`navidrome_ui.py:17-30,51-95`), embed generation (`:97-121`).
- Verify: `/play <url>`, `/search`, `/radio` work; vote-skip requires majority (`music_manager.py:373-392`); radio pre-fetches when queue ≤ 2 (`:187-189`); empty-VC cleanup after 300 s (`:105-126`).

### Phase 5 — WebModule
- NestJS controllers: `GET /` dashboard (`web/app.py:14-18`), `POST /restart` (`:26-31`), `POST /update_config` (`:33-57`, keep gemini-keys-as-lines parsing), `GET /memories` (`:61-91`), `GET /memories/:user_id` (`:93-108`).
- Restart wiring: `main.py:56-67` restart flow becomes an `OnModuleInit`/controller service calling `force_shutdown_and_summarize` (`discord_client.py:884-897`) then re-initializing the client.
- Verify: WebUI serves on port 8000; config form persists to env/store; memories viewer lists `.enc` files with mtime and renders decrypted summary.

### Phase 6 — SchedulerModule
- Port all 6 loops to `@Interval`/`@Cron`:
  1. `check_reminders_task` `discord_client.py:104-205` (1 min) — needs `scheduler.service.ts` port of `core/scheduler.py:124-207` (JSON-block parsing, 600 s due window, dedupe cache TTL 1 h, remove-executed rewrite).
  2. `check_timeouts_task` `:278-293` (60 s) — session timeout + 12.5% farewell via `brain.analyze_interaction` (`conversation_manager.py:147-202`).
  3. `process_memory_queue_task` `:899-916` (60 s) — `process_queue` (>5 min → permanent) + stale buffers (>30 min) → summarize.
  4. `recovery_check_task` `:841-869` (60 s) — sleep-until + `testApiConnection`, extend 2 h on failure.
  5. `check_holidays_task` `:918-960` (60 s) — GMT-4 clock, `data/holidays.json` dedupe, `celebrate_holiday` `:962-991`.
  6. `check_empty_voice_channels` `music_manager.py:105-130` (1 min).
- Verify: timeouts, reminders (including persisted dedupe across restarts), holiday dedupe, memory-queue flush, recovery loop, empty-VC disconnect.

### Phase 7 — Cutover + decommission
- Run NestJS alongside Python (different bot token or same token with queueing disabled) in a staging server; shadow-compare responses.
- Move `data/status_messages.json` (`discord_client.py:242-249`), `data/holidays.json`, migrated memory dir into the NestJS data layout.
- Point launch at `nest start` (or Docker — update `docker-compose.yml`, `Dockerfile`, `launch.sh`); remove `main.py`, `bot/`, `core/`, `web/`, `requirements.txt`, `run_tests.py` → `simulate_conversation.py` equivalents live under `test/`.

---

## 6. Security fixes to apply during port

- **Credentials to env vars.** Navidrome `base_url`, `external_url`, `username`, `password` are hardcoded at `bot/navidrome_client.py:9-13` (plaintext password `<REDACTED>`). Move all to `.env` via `ConfigService`. Same for every API key currently in plaintext `data/config.json` (`config_manager.py:21-29`: `bot_token`, `gemini_keys`, `nanogpt_api_key`). See `04-data-security.md`.
- **Redact PII logs.** `[DM INPUT]` (author name, ID, content, attachment filenames) is printed unconditionally at `discord_client.py:332-338`; `[DM OUTPUT]` at `:733-737`; stealth-DM payload at `:797`. Gate all three behind a debug flag (`LOG_DM_CONTENT=true`) or strip message content. DM contents are private-user data.
- **Navidrome password in stream/cover URLs.** `get_stream_url`/`get_cover_url` embed `u`/`t`/`s` params in URLs (`navidrome_client.py:128-141`). These leak the salted token; consider short-lived signed tokens or, at minimum, ensure URLs are never logged (the `[MD OCULTO]` log at `:797` does not include URLs, but future logs must not add them).
- **Encryption key handling.** The Fernet key sits in `data/memory/secret.key` (`memory_manager.py:7,28-36`). Move to env/secret storage; if kept on disk, set 0600 and gitignore. AES-256-GCM key derivation per `04-data-security.md`.
- **WebUI auth.** FastAPI WebUI has no auth and exposes `POST /restart` and full config (including keys) (`web/app.py:26-57`). Port to NestJS with the same exposure level but flag it: bind to localhost or add a simple token before exposing beyond localhost.

---

## 7. Open questions / risks

- **YouTube extraction**: yt-dlp has no direct JS equivalent. `play-dl`/`ytdl-core` break more often (YouTube anti-bot) than `yt_dlp` does today (`music_manager.py:3,38-59`; also the oEmbed/`ytimg` fallbacks at `discord_client.py:503-590`). Consider a **sidecar yt-dlp HTTP service** (Python container exposing `/extract?url=`) and have `MusicModule` call it. Decision needed in Phase 4.
- **Fernet data migration**: existing `.enc` files use Fernet (not raw AES). A Node `crypto` AES-256-GCM rewrite canNOT read them without a Python one-shot decryptor (`scripts/migrate_fernet.py`) or a re-key. Budget for this in Phase 1; do not delete `secret.key` until migration is verified.
- **Volume/audio quality parity**: `PCMVolumeTransformer(volume=0.5)` default (`music_manager.py:31,210`) vs `@discordjs/voice` `VolumeTransformer` — confirm the effective gain matches so playback is not louder/quieter.
- **Voice connection stabilization**: the 30 s connect-wait + 1 s UDP settle sleeps (`music_manager.py:147-153,227-230`) exist to avoid the "audio at 2x speed" bug. `@discordjs/voice`'s `joinVoiceChannel` handles this differently — verify on a real guild.
- **Typing indicator parity**: Python uses `channel.typing()` context managers (`discord_client.py:300,661,718`). `discord.js` has `channel.sendTyping()` — check debounce/typing UX is preserved (typing state map at `:256-276`).
- **Global vs guild command sync**: Python uses global `tree.sync()` (`:88`). necord should offer `guildCommands` for the `!sync` debug path (`:319-329`). Decide rollout strategy in Phase 3.
- **`reply_probability` randomness**: probability-based trigger at 1% default (`discord_client.py:366-369`) is nondeterministic — keep the config key and use `Math.random()`.
- **Token/char budgeting**: `analyze_interaction` has an 800k-char budget with history truncation (`ai_handler.py:539-563`). Port faithfully; Gemini context differs from the NanoGPT path it currently also feeds.
