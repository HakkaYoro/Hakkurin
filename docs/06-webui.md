# 06 — WebUI (`web/`)

Admin/control panel for Hakkurin. A single-file FastAPI app (`web/app.py`, 111 lines) with three Jinja2 templates serving five routes: live configuration editing (writes `data/config.json`), bot restart control, and per-user memory browsing. It is not a public-facing UI — it is an unauthenticated admin surface that anyone reaching the port can operate.

Related docs: [00-overview.md](00-overview.md) (entry point, Docker), [01-architecture.md](01-architecture.md) (inter-module contract), [02-ai-system.md](02-ai-system.md) (NanoGPT→Gemini migration affects one form field), [04-data-security.md](04-data-security.md) (secrets/security debt), [03-nestjs-port-plan.md](03-nestjs-port-plan.md) (Phase 5 WebModule target).

---

## 1. Server

| Aspect | Value | Source |
| --- | --- | --- |
| Framework | FastAPI, single module | `web/app.py:1-9` |
| App object | `app = FastAPI()` | `web/app.py:9` |
| Template engine | Jinja2, `Jinja2Templates(directory="web/templates")` | `web/app.py:12` |
| Static files | `StaticFiles` **imported but never mounted** (`web/app.py:3`) — no static asset route exists | `web/app.py:3` |
| ASGI server | `uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")` | `web/app.py:110-111` |
| Host:port | `0.0.0.0:8000` (binds all interfaces — reachable beyond localhost) | `web/app.py:111` |
| Docker exposure | host `30421` → container `8000` | `docker-compose.yml` (`"30421:8000"`) |
| Threading | started as a **daemon thread** from `main.py` under `if __name__ == "__main__"` | `main.py:76-77` |
| Startup log | `"WebUI iniciada en http://localhost:8000"` | `main.py:78` |

Boot sequence in `main.py`:

1. `web.app.set_restart_callback(restart_system)` — wires the restart hook before serving (`main.py:74`).
2. `threading.Thread(target=run_web_server, daemon=True).start()` — uvicorn runs on a background daemon thread; the main thread never blocks on the web server (`main.py:76-77`).
3. `run_web_server()` calls `uvicorn.run(...)` which blocks on that thread until process exit (`web/app.py:110-111`).

The template directory path `web/templates` is **relative** — it resolves against the process CWD, so uvicorn must be launched from the repo root (as `main.py` does). A port should make this absolute or config-relative.

---

## 2. Routes (table)

| Method | Path | Handler | Purpose | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/` | `read_root` | Render the config control-center form with current values | `index.html` (`web/app.py:14-18`) |
| `POST` | `/update_config` | `update_config` | Read form fields, persist each to `data/config.json` via `config.set` | `303 RedirectResponse → /?saved=true` (`web/app.py:33-57`) |
| `POST` | `/restart` | `restart_bot` | Invoke the registered restart callback (→ bot loop reloads) | `303 RedirectResponse → /?restarted=true`, or `500` if no callback set (`web/app.py:26-31`) |
| `GET` | `/memories` | `list_memories` | List per-user memory `.enc` files with last-modified date | `memories.html` (`web/app.py:61-91`) |
| `GET` | `/memories/{user_id}` | `view_memory` | Decrypt/display one user's memory summary | `memory_view.html` (`web/app.py:93-108`) |

There is no other route. No auth, no CSRF protection, no rate limiting on any of them.

---

## 3. `POST /update_config` — form-field → config-key mapping

Handler definition (`web/app.py:33-43`) — FastAPI `Form(...)` params, `nanogpt_api_key` optional:

```python
@app.post("/update_config")
async def update_config(
    request: Request,
    bot_name: str = Form(...),
    bot_token: str = Form(...),
    system_prompt: str = Form(...),
    reply_probability: float = Form(...),
    developer_id: str = Form(...),
    gemini_keys: str = Form(...),  # textarea, one key per line
    nanogpt_api_key: str = Form("") # Opcional
):
```

Every field is then written with `config.set(key, value)` at `web/app.py:48-55`. Each `config.set` call **persists immediately** because `ConfigManager.set` calls `save_config()` internally (`core/config_manager.py:42-44`, JSON written to `data/config.json`).

| Form field | Template refs (`index.html`) | Handler param | Config key | Normalization |
| --- | --- | --- | --- | --- |
| `bot_name` (text) | `:136-139` | `bot_name` `:36` | `bot_name` | stored as-is |
| `bot_token` (text) | `:141-144` | `bot_token` `:37` | `bot_token` | stored as-is (plaintext secret) |
| `gemini_keys` (textarea, one per line) | `:146-150` | `gemini_keys` `:41` | `gemini_keys` | `[k.strip() for k in gemini_keys.split('\n') if k.strip()]` → list of non-empty stripped keys (`:45`) |
| `nanogpt_api_key` (text, optional) | `:152-156` | `nanogpt_api_key` `:42` (default `""`) | `nanogpt_api_key` | set **only if non-empty** after strip (`:54-55`); an emptied field does NOT clear an existing value |
| `reply_probability` (number 0.0–1.0) | `:158-162` | `reply_probability` `:39` (typed `float`) | `reply_probability` | validated as float by FastAPI; template uses `step="0.01" min="0" max="1"` |
| `system_prompt` (textarea) | `:164-167` | `system_prompt` `:38` | `system_prompt` | stored as-is |
| `developer_id` (text, Discord user ID) | `:169-172` | `developer_id` `:40` | `developer_id` | stored as-is |

Form posts to `action="/update_config" method="post"` (`index.html:135`). On success the handler returns `RedirectResponse(url="/?saved=true", status_code=303)` (`web/app.py:57`); the template's inline JS shows a success alert when `?saved=true` is present and clears the URL (`index.html:189-199`).

> **`allowed_channels` is NOT editable via the WebUI.** The config key exists (default `[]` at `core/config_manager.py:25`) and is *read* by the bot to gate which server channels the bot responds in (`bot/discord_client.py:310-312`: ignores guild messages whose channel is not in the list, when the list is non-empty), but neither the form (`index.html`) nor the handler (`web/app.py:33-57`) writes it. Channel allow-listing is therefore configurable only by hand-editing `data/config.json` today. A port should either add the field or document the gap.

> **`nanogpt_api_key` is slated for removal.** It is the only NanoGPT-specific field and is to be deleted in the Gemini-only migration (Section B of `02-ai-system.md`; remove `web/app.py:42` and the set-if-non-empty block at `web/app.py:54-55`).

---

## 4. `POST /restart` + restart mechanism (end-to-end)

This is how config changes go live **without a full process restart**: the WebUI sets a flag, the main loop detects it, reloads config, and constructs a brand-new `HakkurinBot()` instance.

### 4.1 Callback registration

- `set_restart_callback(callback)` stores the callable in module-global `restart_callback` (`web/app.py:20-24`).
- `main.py:74` registers `restart_system` before the web thread starts.

```python
# web/app.py:20-24
restart_callback = None
def set_restart_callback(callback):
    global restart_callback
    restart_callback = callback
```

### 4.2 `POST /restart` handler

```python
# web/app.py:26-31
@app.post("/restart")
async def restart_bot(request: Request):
    if restart_callback:
        restart_callback()
        return RedirectResponse(url="/?restarted=true", status_code=303)
    return HTMLResponse("Error: No restart callback set", status_code=500)
```

The form that triggers it is the "Zona de Peligro / Control" card (`index.html:178-186`, red-bordered, `form action="/restart" method="post"`, button text "⚠️ Reiniciar Bot y Recargar Memorias ⚠️"). The template shows an `alert("El bot se está reiniciando...")` when `?restarted=true` is present (`index.html:200-203`).

### 4.3 `restart_system()` (`main.py:56-67`)

```python
def restart_system():
    global should_restart, current_bot
    should_restart = True
    if current_bot and current_bot.loop and not current_bot.is_closed():
        try:
            asyncio.run_coroutine_threadsafe(current_bot.force_shutdown_and_summarize(), current_bot.loop)
        except Exception as e:
            logger.error(f"Error al intentar cerrar el bot: {e}")
```

Two effects:

1. **Sets `should_restart = True`** (module-global, `main.py:35`) — the main loop's restart condition.
2. **Schedules a graceful shutdown on the bot's own event loop** via `asyncio.run_coroutine_threadsafe(current_bot.force_shutdown_and_summarize(), current_bot.loop)` (`main.py:65`) — because `POST /restart` runs on the FastAPI thread, it cannot `await` the bot's coroutine directly; the coroutine is shipped to the loop the bot's `run()` is blocking on. `force_shutdown_and_summarize` lives at `bot/discord_client.py:884-897` (per `03-nestjs-port-plan.md` Phase 5) — it flushes/encrypts pending memory before the client closes.

Guarded by `current_bot and current_bot.loop and not current_bot.is_closed()` so a restart request when the bot is offline (e.g., awaiting config) does not crash.

### 4.4 Main-loop consumption (`main.py:83-110`)

```python
while True:
    config.load_config()
    brain.reload_config()       # reload AI keys
    should_restart = False
    bot_started = run_bot()     # blocking; constructs a NEW HakkurinBot() and run(token)
    current_bot = None
    if not bot_started and not should_restart:
        while not should_restart:   # idle-poll until a restart is requested
            time.sleep(1)
    if should_restart:
        time.sleep(3)           # give the old client time to close
        # loop continues → run_bot() again with the new config
    else:
        break                    # crash/CTRL+C without restart request → exit
```

Per iteration, before starting the bot, config and AI keys are reloaded from disk: `config.load_config()` (`core/config_manager.py:18-33`) and `brain.reload_config()` (`main.py:86`; AI-handler key reload). `run_bot()` builds a **new** `HakkurinBot()` each time and calls the blocking `current_bot.run(token)` (`main.py:37-54`). If the bot never started (no valid token) and no restart was requested, the loop sleep-polls every 1 s until `should_restart` flips (`main.py:97-101`) — i.e., the WebUI restart button doubles as the "apply config now" trigger even when the bot is offline.

Net behavior: `POST /restart` → callback → flag + async shutdown → main loop observes flag → waits 3 s → reloads `data/config.json` + AI keys → rebuilds the client. End-to-end the WebUI is the only mutation surface for live config.

---

## 5. Memory routes

### 5.1 `GET /memories` — list (`web/app.py:61-91`)

**Data source is `data/memory/users/*.enc`, not the plaintext summaries.** Despite the plaintext summary mirrors living at `data/memory/summaries/*.txt` (`core/memory_manager.py:251-257`), the listing route enumerates the encrypted per-user files to derive mtimes:

- `memory_dir = "data/memory/users"` (`:64`).
- Iterates the directory, keeps `*.enc` files (`:68-69`), derives `user_id = filename.replace(".enc", "")` (`:70`).
- Reads file mtime via `os.path.getmtime` and formats `%Y-%m-%d %H:%M:%S` (`:73-76`).
- Marks `is_self = True` when `user_id == memory.BOT_SELF_ID` (`:81-82`); `BOT_SELF_ID = "hakkurin_internal_self"` (`core/memory_manager.py:206`).
- Sorts by date string descending (`:87`), renders `memories.html` with the list (`:89-91`).

### 5.2 `GET /memories/{user_id}` — single view (`web/app.py:93-108`)

Reads through the `MemoryManager` singleton (`from core.memory_manager import memory`, `web/app.py:59`):

- If `user_id == memory.BOT_SELF_ID` → `memory.get_self_memory()` (`:97-98`), which returns the `summary` field of the decrypted self-memory (`core/memory_manager.py:208-211`).
- Otherwise → `memory.get_memory_summary(user_id)` (`:100`), which decrypts the user's `.enc`, reads its encrypted `summary`, and builds the plaintext prompt-injection string (notes + long-term summary + queued/recent memory + profile name/likes) — `core/memory_manager.py:273-295`. Summary is drawn from the **encrypted** store, not the `.txt` mirror.
- If the summary is empty → placeholder `"Sin resumen generado aún."` (`:101`).
- Any exception → `f"Error leyendo memoria: {str(e)}"` rendered into the page (`:102-103`).

Security note: `user_id` is interpolated directly into the template path (`/memories/{user_id}`) and rendered in the page title/heading — no ID sanitization, but the only filesystem access is via `MemoryManager`'s sanitized paths (`_sanitize_user_id` strips whitespace only, `core/memory_manager.py:53-54`), so path traversal is bounded by the `.enc` suffix join.

---

## 6. Templates (`web/templates/`)

All three templates share the same dark "neon" aesthetic (CSS custom properties `--bg-color:#0f0f13`, `--card-bg:#1a1a23`, `--accent-color:#ff79c6` pink, `--secondary-accent:#bd93f9` purple). Language is Spanish.

### `index.html` — config control center ("Hakkurin Dashboard")

- `h1` "Hakkurin Dashboard" (`:120`); hidden `#success-msg` alert div (`:122-124`).
- Nav button linking to `/memories` — "🧠 Ver Memorias de Usuarios" (`:126-132`).
- Config form (`:135-175`, `action="/update_config"`) — field layout, all values **pre-filled from live config** (see the mapping table in §3): `bot_name` `:138`, `bot_token` `:143`, `gemini_keys` textarea loop `:148-149`, `nanogpt_api_key` `:154-155`, `reply_probability` `:160-161`, `system_prompt` textarea `:166`, `developer_id` `:171`. Submit button "Guardar Cambios" (`:174`).
- Danger zone restart form (`:178-186`, `action="/restart"`) with red gradient button.
- Inline JS (`:189-204`): shows the success alert for 3 s on `?saved=true` (clearing the URL via `history.replaceState`), and a JS `alert` on `?restarted=true`.

**File quirk:** the raw file starts with a literal markdown fence line ` ```html ` (line 1) and ends with a bare ` ``` ` (line 208), and uses CRLF line endings. These stray fence markers are part of the served file but are inert in HTML rendering — harmless in practice, worth stripping in a port.

### `memories.html` — memory list

- Back link "← Volver al Dashboard" (`:90`), `h1` "Memorias de Usuarios 🧠" (`:91`).
- Empty state "No hay memorias guardadas aún." (`:93-95`).
- `<ul class="memory-list">` (`:96-114`): each item is a link to `/memories/{{ mem.user_id }}` (`:99`); displays `ID: {{ mem.user_id }}` plus, when `mem.is_self`, a pink "🧠 MEMORIA INTERNA" badge (`:103-107`); right-aligned `Actualizado: {{ mem.date }}` (`:109`). Self-memory items get the accent-colored `.internal-memory` border (`:100`, CSS `:58-60`).

### `memory_view.html` — single memory detail

- Back link "← Volver a la lista" (`:57`), title `Memoria de {{ user_id }}` (`:58`).
- `<div class="content-box">{{ content }}</div>` — `white-space: pre-wrap` so multi-line summary text renders as-is (`:59`, CSS `:36-43`).

---

## 7. Security notes (summary — full detail in `04-data-security.md`)

The WebUI is the single largest secret-exposure surface in the project:

- **No authentication/authorization** on any route. The uvicorn bind is `0.0.0.0:8000` (`web/app.py:111`) and Docker publishes `30421:8000` (`docker-compose.yml`) — anyone who can reach the port can read config, rewrite secrets, wipe channels config, and trigger restarts.
- **Plaintext secrets at rest and in transit.** `POST /update_config` stores `bot_token`, `gemini_keys`, and `nanogpt_api_key` verbatim into `data/config.json` (`core/config_manager.py:4, 35-37`, non-atomic `json.dump`). See security-debt rows #1 and #6 in `04-data-security.md` §8.
- **Secrets echoed back into the DOM.** Every text input is pre-filled with the live value: `index.html:138` (`bot_name`), `:143` (`bot_token`), `:148-149` (`gemini_keys` textarea — full keys rendered as text), `:154` (`nanogpt_api_key`), `:160` (`reply_probability`), `:166` (`system_prompt`), `:171` (`developer_id`). A full page render leaks every key to any viewer.
- **Plaintext summary mirrors** in `data/memory/summaries/*.txt` exist for WebUI convenience (`core/memory_manager.py:251-257`); the WebUI view route actually decrypts from `.enc`, so the mirrors are redundant exposure.

Port recommendation (mirrors `04-data-security.md` §9 and `03-nestjs-port-plan.md` §6): gate the whole module behind authentication; make secret fields **write-only** — render `has_value: true` plus a masked display and never populate the input's `value` from the store; use `@nestjs/config`/env for secrets instead of a JSON config file.

---

## 8. Port mapping to NestJS (summary — full plan in `03-nestjs-port-plan.md` Phase 5)

| Python | NestJS target |
| --- | --- |
| `FastAPI` app + route decorators (`web/app.py:14-108`) | `WebModule` controllers — `GET /` dashboard, `POST /restart`, `POST /update_config` (preserve gemini-keys-as-lines parsing), `GET /memories`, `GET /memories/:user_id` (`03-nestjs-port-plan.md` Phase 5, `:231-236`) |
| `Jinja2Templates` (`web/app.py:12`) | NestJS view engine (e.g., server-side rendering) or static served HTML + fetch API |
| `set_restart_callback` + global `restart_callback` (`web/app.py:20-24`) | A `RestartService` (injectable) or event-emitter invoked by the `POST /restart` controller |
| `restart_system()` / `asyncio.run_coroutine_threadsafe` (`main.py:56-67`) | Controller/service calling `force_shutdown_and_summarize` then re-initializing the Discord client — on NestJS the "re-init" is a gateway lifecycle concern (e.g., `OnModuleInit` recreating the client with fresh `ConfigService` values) |
| `should_restart` flag + main loop (`main.py:83-110`) | Replaced by NestJS module lifecycle: config updates trigger client teardown/reconnect rather than a sleep-poll loop |
| `run_web_server()` / uvicorn daemon thread (`main.py:76-77`, `web/app.py:110-111`) | NestJS HTTP bootstrap on port 8000 (Nest replaces uvicorn; no separate thread needed) |
| Relative template dir `web/templates` (`web/app.py:12`) | Absolute/static asset path via `@nestjs/serve-static` or a configured view dir |

Verification criteria from the port plan: WebUI serves on port 8000; config form persists to env/store; memories viewer lists `.enc` files with mtime and renders decrypted summary.
