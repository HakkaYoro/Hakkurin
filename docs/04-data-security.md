# 04 — Data Security

Agent-oriented reference for the Nest.JS port. Documents every persistent data file, the encryption scheme, secret handling, current security debt, and port recommendations.

Related docs: [`00-overview.md`](00-overview.md), [`01-architecture.md`](01-architecture.md), [`02-ai-system.md`](02-ai-system.md), [`03-nestjs-port-plan.md`](03-nestjs-port-plan.md).

---

## 1. Config schema — `data/config.json`

Managed exclusively by the `ConfigManager` singleton in `core/config_manager.py`. `CONFIG_FILE = "data/config.json"` (`core/config_manager.py:4`). Singleton via `__new__` (`core/config_manager.py:9-16`); module-level instance `config` (`core/config_manager.py:47`).

API:

| Method | Behavior | Ref |
|---|---|---|
| `load_config()` | Reads JSON from `data/config.json`; **if missing, writes hardcoded defaults** | `core/config_manager.py:18-33` |
| `save_config()` | `json.dump(..., indent=4, ensure_ascii=False)` — **plain non-atomic write**, no temp+`os.replace` | `core/config_manager.py:35-37` |
| `get(key, default=None)` | Dict read | `core/config_manager.py:39-40` |
| `set(key, val)` | In-place update + immediate `save_config()` | `core/config_manager.py:42-44` |

Schema (all values `<REDACTED>` by key name; structure verified against `data/config.json`):

| Key | Type | Purpose | Notes |
|---|---|---|---|
| `bot_token` | string | Discord bot token | `<REDACTED>`. Validated in `main.py:40`; empty or placeholder `TU_TOKEN_DE_DISCORD_AQUI` blocks bot start |
| `gemini_keys` | string[] | 6 Google AI Studio keys; multi-key rotation pool | `<REDACTED>`. Rotation logic lives in `core/ai_handler.py` (see `02-ai-system.md`) |
| `nanogpt_api_key` | string | NanoGPT direct-reply key | `<REDACTED>`. **TO BE REMOVED** in the Gemini-only migration — see `02-ai-system.md` |
| `bot_name` | string | Display/persona name | On-disk `"Hakkurin"`; default in code `"Hakkurin"` (`core/config_manager.py:24`) |
| `allowed_channels` | string[] | Channel-ID whitelist; empty = all channels | DMs **always** pass the whitelist check — `bot/discord_client.py:310-313` |
| `system_prompt` | string | Personality/system prompt | Spanish e-girl/otaku persona. Default at `core/config_manager.py:26`; on-disk copy differs |
| `reply_probability` | float | Probabilistic reply trigger (0.0–1.0) | On-disk `0.12`; code default `0.125` (`core/config_manager.py:27`); read in `bot/discord_client.py:366` |
| `developer_id` | string | Owner/developer Discord ID | `<REDACTED>`. Default baked in code at `core/config_manager.py:28` |

Schema drift note: the on-disk file contains a stray `test_key` (integer) field not present in the code defaults (`core/config_manager.py:21-29`) — a leftover/experimental key that the current code ignores.

Git status: `data/config.json` is **gitignored** (`.gitignore:9` `config.json`, which matches at any depth) and untracked. It is the only live store of the Discord token, all 6 Gemini keys, and the NanoGPT key.

---

## 2. Memory schema

Canonical empty shape from `MemoryManager._create_empty_memory` (`core/memory_manager.py:145-161`):

```json
{
  "profile": {
    "name": "",
    "personality_traits": [],
    "likes": [],
    "dislikes": [],
    "speaking_style": ""
  },
  "interaction_count": 0,
  "last_topics": [],
  "notes": "Usuario nuevo.",
  "summary": "",
  "history_buffer": [],
  "last_summary_time": 0,
  "last_channel_id": null
}
```

`_normalize_memory_schema` (`core/memory_manager.py:56-116`) defensively migrates legacy/partial/corrupt records before every read and write:

- Top-level non-dict → `{}`; starts from `_create_empty_memory()` and `update()`s over it.
- `profile.*`: `personality_traits` / `likes` / `dislikes` coerced to `list[str]` (scalar or wrong type → `[]`); `name` / `speaking_style` → `str` (None → default).
- `interaction_count` → `int` (else 0); `last_topics` → `list`; `notes` → `str` (default `"Usuario nuevo."`); `summary` → `str`.
- `history_buffer` → `list[str]`, dropping non-`str|int|float` items.
- `last_summary_time` → `float` (unparseable → 0); `last_channel_id` → `int` or `None`.

---

## 3. Encryption scheme

Implemented in `core/memory_manager.py`. Uses **Fernet** (symmetric, AES-128-CBC + HMAC-SHA256) from the `cryptography` library (`core/memory_manager.py:4`).

| Path | Purpose | Ref |
|---|---|---|
| `data/memory/secret.key` | Fernet key file (44 bytes base64). Auto-generated via `Fernet.generate_key()` if missing, written raw bytes | `core/memory_manager.py:7, 28-36` |
| `data/memory/users/{user_id}.enc` | Per-user encrypted memory blobs | `core/memory_manager.py:6, 50-54` |
| `data/memory/summaries/{user_id}.txt` | **Plaintext** summary copies for the WebUI viewer | `core/memory_manager.py:8, 251-257` |
| `data/memory/queue.json` | Plaintext JSON queue of pending interactions | `core/memory_manager.py:11` |

Flow:

- **Read** (`get_memory`, `core/memory_manager.py:118-132`): read `.enc` → `cipher.decrypt` → `json.loads` → `_normalize_memory_schema`. Any exception → falls back to empty memory (with a `print`, `:130-132`).
- **Write** (`save_memory`, `core/memory_manager.py:134-143`): normalize → `json.dumps(ensure_ascii=False)` → `cipher.encrypt` → atomic byte write.
- **Atomic writes**: temp file `<path>.tmp` + `os.replace` — `_atomic_write_bytes` (`core/memory_manager.py:38-42`), `_atomic_write_text` (`:44-48`). The queue is also saved atomically (`:369-380`).
- **User-ID sanitization**: `_sanitize_user_id` trims whitespace only (`core/memory_manager.py:53-54`).

Special identity: `BOT_SELF_ID = "hakkurin_internal_self"` (`core/memory_manager.py:206`) — bot self-memory, written through the same encrypted mechanism. Used by `log_self_action` (`:213-217`) and consumed by the scheduler/reminders (`bot/discord_client.py:104-205`, `:758-762`).

**Important:** the self-memory holds the `SCHEDULED_ACTIONS` JSON (see §5), so commitments are encrypted at rest in `data/memory/users/hakkurin_internal_self.enc`. The plaintext mirror lives at `data/memory/summaries/hakkurin_internal_self.txt`.

On-disk state (verified): `data/memory/secret.key`, `queue.json` (`[]`), 4 `.enc` files in `data/memory/users/`, 4 `.txt` files in `data/memory/summaries/` (incl. `hakkurin_internal_self.txt`). All under `data/memory/` are gitignored via the `memory/` pattern (`.gitignore:10`) — confirmed with `git check-ignore`.

---

## 4. Summarization triggers & queue

Constants (`core/memory_manager.py:11-16`):

| Constant | Value | Meaning |
|---|---|---|
| `SUMMARY_TRIGGER_INTERACTIONS` | 20 | Buffer length that forces summarization |
| `SUMMARY_TRIGGER_SECONDS` | 1800 | 30 min since last summary forces summarization |
| `STALE_BUFFER_SECONDS` | 1800 | 30 min — stale-buffer sweep threshold |
| `QUEUE_TO_PERMANENT_DELAY_SECONDS` | 300 | 5 min temp→permanent promotion delay |
| `QUEUE_DUPLICATE_WINDOW_SECONDS` | 10 | Dedupe window for `add_to_queue` |

Flow:

1. **Write path** — every interaction goes to the **temp queue** first (`add_to_queue`, `core/memory_manager.py:382-402`, called from `bot/discord_client.py:820`). Items are `{"user_id", "text", "timestamp"}` (normalized at `:326-350`). Dedupe: identical `(user_id, text)` within 10 s is dropped.
2. **Promotion** — `process_queue` (`core/memory_manager.py:411-438`) moves items older than 5 min into permanent memory via `add_interaction`, returning user_ids that hit a summary trigger.
3. **Summary trigger** — `add_interaction` (`core/memory_manager.py:163-183`) returns `should_summarize` when `len(history_buffer) >= 20` **or** (`history_buffer` non-empty **and** `> 30 min` since `last_summary_time`).
4. **Stale sweep** — `check_stale_buffers` (`:185-203`) collects users with a non-empty buffer whose last summary is `> 30 min` old.
5. **Orchestration** — `process_memory_queue_task` runs every 60 s (`bot/discord_client.py:900-916`): `process_queue` + `check_stale_buffers`, then `perform_memory_summarization` per user.
6. **Commit** — `update_summary` (`core/memory_manager.py:223-246`) writes the new summary, prunes the *processed prefix* of the buffer (fallback: keeps full buffer if prefix mismatch, so new messages aren't lost), stamps `last_summary_time`, and writes the plaintext copy.

---

## 5. Scheduler data format

`SCHEDULED_ACTIONS` is a JSON array **embedded in the bot self-memory summary text** (stored encrypted per §3). Parsed by `core/scheduler.py`.

- Location in text: a ```` ```json [...] ``` ```` markdown-fenced block is primary (`core/scheduler.py:44, 77-84`); falls back to the first balanced top-level `[...]` array in free text (`_find_json_array_candidates`, `:39-75`; `_find_primary_json_block`, `:77-97`).
- Item shape (normalized at `core/scheduler.py:12-37`):

```json
{
  "trigger_time": "2026-08-02 14:30",
  "action_description": "Recordar a Hakka que escriba el capítulo",
  "target_user_id": "<REDACTED>",
  "target_user_name": "Hakka"
}
```

- `trigger_time` accepted formats: `"%Y-%m-%d %H:%M"`, `"%Y-%m-%d %H:%M:%S"`, `"%Y/%m/%d %H:%M"`, `"%Y/%m/%d %H:%M:%S"`, ISO partial (`_parse_trigger_datetime`, `:99-116`).
- Execution window: `DUE_WINDOW_SECONDS = 600` (`core/scheduler.py:7`); `check_due_actions` fires when `0 <= (now - trigger_time) <= 600s` (`:149-170`).
- Dedupe: `build_action_key` = `trigger_time|target_user_id|action_description` (`:118-122`), used by the in-memory cache (`bot/discord_client.py:125-141`) and persisted across restarts by `remove_executed_actions_from_memory`, which rewrites the JSON block in place (`core/scheduler.py:172-207`; invoked at `bot/discord_client.py:200`).

Consumption loop: `check_reminders_task` every 60 s (`bot/discord_client.py:104-205`) → `get_self_memory` → parse → filter due → resolve target channel via `last_channel_id` → AI-generated message → `log_self_action`.

---

## 6. Other data files

| File | Structure | Purpose | Git |
|---|---|---|---|
| `data/status_messages.json` | `{ "tired": [20 str], "recovery": [20 str] }` — Spanish phrase pools | Sleep-mode goodbye / wake-up recovery lines. Loaded in `_load_status_messages` (`bot/discord_client.py:242-249`, fallback defaults on parse error) | tracked |
| `data/holidays.json` | `{}` currently; written as `{ "<key>_<year>": true }`, e.g. `xmas_2026`, `newyear_2026` | Holiday-greeting dedupe state so each event fires once per year (`check_holidays_task`, `bot/discord_client.py:918-960`) | tracked |

---

## 7. `memory/` (repo root) — LEGACY

- Old memory path: `memory/secret.key` + `memory/users/*.enc`. **Not used by current code** — the active path is `data/memory/`.
- Present on disk (verified): `memory/secret.key` (44 B) and 2 legacy `.enc` files (named `<user_id>.enc`, e.g. two real Discord user IDs), dated 2025-12-22, predating the `data/memory/` migration.
- Gitignored via `memory/` (`.gitignore:10`); untracked. Safe to delete during port; do not migrate its contents blindly — old schema is handled by `_normalize_memory_schema`, but its Fernet key differs from the current `data/memory/secret.key`.

---

## 8. Security debt (current)

| # | Issue | Location | Risk |
|---|---|---|---|
| 1 | Plaintext Discord token, 6 Gemini keys, NanoGPT key in `data/config.json` | `core/config_manager.py:4`; file on disk | Total account/API compromise on any file leak or backup sync; secrets not encrypted at rest; non-atomic writes (`:35-37`) risk truncation on crash |
| 2 | Navidrome username + password + both base URLs **hardcoded in source** | `bot/navidrome_client.py:9-13` (`http://192.168.1.104:30043/rest`, `https://navi.hakkurei.com/rest`, user `<REDACTED>`, password `<REDACTED>`) | Credential + internal-network exposure in git history and any source reader; Subsonic token = `md5(password + salt)` (`:22-32`) is trivially replayed |
| 3 | No `.env.example`; `load_dotenv()` called but **no `.env` exists** | `main.py:8, 26`; repo root has no `.env*` | Dead env path — `.env` is gitignored (`.gitignore:4`) but nothing populates it; secrets are forced into `config.json` |
| 4 | `[DM INPUT]` / `[DM OUTPUT]` verbose logging prints full DM content + author name/ID | `bot/discord_client.py:333-338` (input), `:733-737` (output); also analysis text at `:608`, stealth-DM text at `:797` | PII leak: private DM contents persist to disk in `hakkurin.log`; also leaks author identity |
| 5 | Rotating `hakkurin.log` (5 MB × 3 backups) present in working tree (633 KB on disk) | `main.py:11-18` (`RotatingFileHandler`, `:15`); `logging.DEBUG` global level | Accumulates DM content, message analysis, URLs, user IDs; gitignored via `*.log` (`.gitignore:8`) and untracked, but readable by anyone with filesystem access |
| 6 | Plaintext summary mirrors in `data/memory/summaries/*.txt` | `core/memory_manager.py:251-257` | Deliberate WebUI convenience trade-off: user conversation summaries stored unencrypted on disk |

Positive controls already in place: memory bodies are Fernet-encrypted at rest; all writes atomic via `os.replace`; key file auto-generated; `data/config.json`, `data/memory/`, `memory/`, `*.log`, `.env` all gitignored.

---

## 9. Port recommendations (Nest.JS)

Target state — see `03-nestjs-port-plan.md`:

1. **Config via env**: `@nestjs/config` + `.env`, validated with a Joi or zod schema. Add a committed `.env.example` with placeholder values. No secrets in source or JSON.
2. **Navidrome**: move username/password/base URLs to env (both internal and external base URLs). Drop the hardcoded block at `bot/navidrome_client.py:9-13`.
3. **Memory encryption**: replace Fernet with Node `crypto` **AES-256-GCM**. Provide a one-time Fernet→AES converter script for existing `data/memory/users/*.enc` files, **or** re-key on first run (start fresh memories). Preserve the atomic write pattern (temp file + `rename`).
4. **DM logging**: gate verbose `[DM INPUT]`/`[DM OUTPUT]` logging behind a `DEBUG_DM` env flag, or redact message content; never log author IDs at DEBUG by default. Lower the global level from `DEBUG`.
5. **Secrets manager**: evaluate a production secrets manager (env-injected or Vault/cloud KMS) for `bot_token`, `gemini_keys`, Navidrome creds.
6. **WebUI**: the config form (`web/` module, sets values via `ConfigManager.set`) must not echo full key/token values back into the DOM — return `has_value: true` plus masked display, write-only on submit.
7. **Housekeeping**: delete legacy `memory/`; exclude `hakkurin.log` and all `data/memory/**` from backups/artifacts; scrub the leaked Navidrome password and any tokens from git history.
