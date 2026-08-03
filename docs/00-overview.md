# 00 — Overview

Hakkurin is an AI-personality Discord bot: it is not command-driven but "lives" in a server — it listens, decides probabilistically when to speak, runs intent analysis (reply / ignore / complain / topic-change), and maintains per-user long-term memory so it remembers names, preferences, and past conversations. Its brain is dual-provider: NanoGPT via the OpenAI SDK is the primary response generator, with Google Gemini (Google GenAI SDK) as fallback. Every user's memory is encrypted at rest (Fernet). The bot also plays music from YouTube (`yt-dlp`) and from Navidrome (Subsonic API), and exposes a FastAPI/Jinja2 WebUI for runtime configuration, memory browsing, and restart control.

See also: [01-architecture.md](01-architecture.md), [02-ai-system.md](02-ai-system.md), [03-nestjs-port-plan.md](03-nestjs-port-plan.md), [04-data-security.md](04-data-security.md), [05-music-system.md](05-music-system.md), [06-webui.md](06-webui.md).

## Tech stack

| Layer / Component | Python lib/framework | Purpose |
| --- | --- | --- |
| Discord bot | `discord.py[voice]` | Gateway client, message/event handling (`bot/discord_client.py`) |
| Voice/audio | `PyNaCl` + `discord.py[voice]` | Voice-channel audio transport |
| AI primary | `openai` (OpenAI SDK) | NanoGPT response generation (`core/ai_handler.py:60-88`) |
| AI fallback | `google-genai` | Gemini (2.5 Flash) response generation |
| Web search | `ddgs` | DuckDuckGo search for context/live info |
| WebUI | `fastapi`, `python-multipart` | Admin panel, config forms, memory viewer (`web/app.py`) |
| ASGI server | `uvicorn` | Serves the WebUI (`web/app.py:110-111`) |
| Templating | `jinja2` | HTML templates (`web/templates/`) |
| Memory encryption | `cryptography` (Fernet) | Encrypt per-user memory files (`core/memory_manager.py:4`) |
| Music source 1 (YouTube) | `yt-dlp` | YouTube audio extraction/playback (`bot/music_manager.py:3`) |
| Music source 2 (Navidrome) | `aiohttp` | Navidrome / Subsonic API client (`bot/navidrome_client.py:1`) |
| Config | `python-dotenv` + stdlib `json` | `.env` loading (`main.py:26`) and `data/config.json` (`core/config_manager.py`) |

Dependencies declared in `requirements.txt` (one per line): `discord.py[voice]`, `google-genai`, `cryptography`, `fastapi`, `uvicorn`, `python-dotenv`, `jinja2`, `python-multipart`, `openai`, `ddgs`, `yt-dlp`, `PyNaCl`.

## Entry point (`main.py`)

Flow of `python main.py`:

1. **Logging setup** (`main.py:11-23`): `logging.basicConfig(level=DEBUG)` with two handlers — `RotatingFileHandler("hakkurin.log", maxBytes=5*1024*1024, backupCount=3, encoding='utf-8')` and `StreamHandler(sys.stdout)`. `discord.player` forced to DEBUG (`:20`), `discord.voice_state` to WARNING (`:21`).
2. **Env load** (`main.py:26`): `load_dotenv()` — tolerates a missing `.env`; real config comes from `data/config.json`.
3. **Imports** (`main.py:28-30`): `core.config_manager.config` singleton, `bot.discord_client.HakkurinBot`, `web.app.run_web_server`.
4. **WebUI thread** (`main.py:69-78`): under `if __name__ == "__main__"`, registers `web.app.set_restart_callback(restart_system)` (`main.py:74`; defined at `web/app.py:22`, consumed by `POST /restart` at `web/app.py:26-31`), then starts a daemon `threading.Thread(target=run_web_server)` which runs uvicorn on `0.0.0.0:8000` (`web/app.py:110-111`).
5. **Infinite loop** (`main.py:83-110`): each iteration —
   - `config.load_config()` and `brain.reload_config()` (`main.py:85-86`) reload config + AI keys from disk before starting;
   - resets `should_restart = False` (`main.py:88`);
   - calls `run_bot()` (`main.py:92`), which constructs a **new** `HakkurinBot()` instance and calls the blocking `bot.run(token)` (`main.py:48-50`);
   - if the bot did not start and no restart was requested, it sleep-polls `time.sleep(1)` until `should_restart` becomes true (`main.py:97-101`);
   - if `should_restart` is set, sleeps 3 s and loops to rebuild the bot with the new config (`main.py:103-106`);
   - otherwise (crash/CTRL+C, no restart request) breaks and exits (`main.py:107-110`).
6. **`run_bot()`** (`main.py:37-54`): reads `config.get("bot_token")`; if missing or still the placeholder `"TU_TOKEN_DE_DISCORD_AQUI"`, logs a warning and returns `False` (bot stays offline until configured via WebUI).
7. **`restart_system()`** (`main.py:56-67`): sets `should_restart = True` and schedules `current_bot.force_shutdown_and_summarize()` onto the bot's event loop via `asyncio.run_coroutine_threadsafe`.

## Repo tree (top 2 levels)

```
Hakkurin/
├── main.py                      # Entry point: WebUI thread + infinite bot restart loop
├── README.md                    # User-facing README (partly stale — see Known staleness)
├── requirements.txt             # Python dependencies
├── Dockerfile                   # python:3.11-slim image; installs git/ffmpeg/libsodium-dev
├── docker-compose.yml           # ghcr.io/hakkayoro/hakkurin:latest; 30421→8000; volume hakkurin_data:/app/data
├── launch.sh                    # Create/activate venv, pip install, run python3 main.py
├── .gitignore                   # Ignores venv/, .env, *.log, config.json, memory/, __pycache__/
├── .github/                     # GitHub workflows
├── LICENSE                      # License
├── debug_models.py              # Ad-hoc model-debugging script (repo root)
├── run_tests.py                 # Test-runner entry point
├── simulate_conversation.py     # Ad-hoc conversation simulation script
├── bot/                         # Discord client + music
│   ├── discord_client.py        # HakkurinBot (994 lines): events, intent, DM/message handling
│   ├── music_manager.py         # YouTube playback via yt-dlp + discord.py voice
│   ├── navidrome_client.py      # Navidrome (Subsonic API) client via aiohttp
│   ├── navidrome_ui.py          # Navidrome embeds/UI helpers
│   └── __init__.py
├── core/                        # Brain, config, memory, scheduler
│   ├── ai_handler.py            # AI brain: NanoGPT primary + Gemini fallback (856 lines)
│   ├── config_manager.py        # Config singleton; load/save data/config.json
│   ├── conversation_manager.py  # Intent analysis, session/thread management
│   ├── memory_manager.py        # Encrypted per-user memory; data/memory/users/*.enc
│   ├── scheduler.py             # Scheduled tasks / reminders
│   └── __init__.py
├── data/                        # Runtime data (config + encrypted memory)
│   ├── config.json              # [GITIGNORED] Live config (see config keys below)
│   ├── holidays.json            # Holiday data
│   ├── status_messages.json     # Pool of status messages
│   └── memory/                  # [GITIGNORED] Encrypted memory store (Fernet)
│       ├── secret.key           # Fernet key
│       ├── queue.json           # Queue/state file
│       ├── summaries/           # Per-user memory summaries
│       └── users/               # Per-user encrypted *.enc files
├── memory/                      # [GITIGNORED] LEGACY — unused by current code; old encrypted store
│   ├── secret.key
│   └── users/                   # Old *.enc user files
├── tools/                       # Dev tooling
│   └── list_models.py           # Lists available AI models
├── tests/                       # pytest suite (test_ai, test_config, test_conversation, test_memory, ...)
├── web/                         # FastAPI WebUI
│   ├── app.py                   # FastAPI app, routes, run_web_server() → uvicorn 0.0.0.0:8000
│   ├── __init__.py
│   └── templates/               # Jinja2 templates (index.html, memories.html, memory_view.html)
├── venv/                        # [GITIGNORED] Local virtualenv (Python 3.14.6)
├── .pytest_cache/               # pytest cache (self-ignored by its own .gitignore)
├── hakkurin.log                 # [GITIGNORED] Rotating runtime log
└── docs/                        # This documentation set (00-overview, 01-architecture, ...)
```

### Gitignore notes

Patterns from `.gitignore`: `venv/`, `.env`, `*.log`, `config.json` (matches at any depth, so `data/config.json` is ignored), `memory/` (matches both root `memory/` and `data/memory/`), `__pycache__/`, `*.py[cod]`. Verified with `git check-ignore`.

### Config keys (`data/config.json`)

Key names only — values redacted as `<REDACTED>`:

```json
{
  "bot_token": "<REDACTED>",
  "gemini_keys": ["<REDACTED>"],
  "bot_name": "<REDACTED>",
  "allowed_channels": "<REDACTED>",
  "system_prompt": "<REDACTED>",
  "reply_probability": "<REDACTED>",
  "test_key": "<REDACTED>",
  "developer_id": "<REDACTED>",
  "nanogpt_api_key": "<REDACTED>"
}
```

## How to run

### Local

```bash
./launch.sh
# or manually:
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

`launch.sh` creates/activates `venv/` if missing, runs `pip install -r requirements.txt`, then `python3 main.py`.

### Docker

```bash
docker compose up
```

- Image: `ghcr.io/hakkayoro/hakkurin:latest`, `restart: unless-stopped`.
- Port: host `30421` → container `8000` (WebUI).
- Volume: named volume `hakkurin_data` mounted at `/app/data` — persists config and encrypted memory.
- Note: `Dockerfile:22` runs `mkdir -p memory/users`, but the compose volume mounts `/app/data`; the actual memory path used by code is `data/memory/` (`web/app.py:64`), so the `memory/` dir created in the image is vestigial.

### First run

Start the process (local or Docker), open WebUI at `http://localhost:8000`, submit the config form (`POST /update_config`, `web/app.py:33-57`) with the Discord bot token and AI keys, then trigger `POST /restart` or wait for the bot's restart loop. The bot stays offline until a valid `bot_token` is set (`main.py:40-43`).

## Runtime notes

- **Python versions**: Docker image is `python:3.11-slim` (`Dockerfile:2`); local venv is Python 3.14.6 (`venv/bin/python --version`). README claims Python 3.9+.
- **System packages in image** (`Dockerfile:12`): `git`, `ffmpeg` (music extraction/playback), `libsodium-dev` (voice crypto / PyNaCl).
- **Env behavior**: `.env` is loaded if present but does not exist in the repo (gitignored); all real configuration lives in `data/config.json`.
- **WebUI**: served by uvicorn on `0.0.0.0:8000` (`web/app.py:110-111`); restart callback wired at `main.py:74` / `web/app.py:22`.

## Known README staleness

1. **Docker**: `README.md:81-83` (ES) / `:173-175` (EN) say "Docker (Coming Soon)"/"in development", but working `Dockerfile` and `docker-compose.yml` exist and are functional.
2. **AI provider**: README presents Gemini 2.5 Flash as the sole brain (`README.md:19`, `:111`, badge `:5`); the code actually uses NanoGPT as primary via the OpenAI SDK (`core/ai_handler.py:60-88`) with Gemini as fallback.
3. **Persistence path**: README says to mount `/memory` (`README.md:87`, `:179`); `docker-compose.yml` mounts `hakkurin_data:/app/data`, and code uses `data/memory/`.
4. **`.env`**: README/`main.py` reference `.env`, but it does not exist; `load_dotenv()` (`main.py:26`) is effectively a no-op and the real config is `data/config.json`.
5. **Python version**: README says Python 3.9+; local venv is 3.14.6 and Docker is 3.11-slim.
