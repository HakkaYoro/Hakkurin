# 01 — Architecture

Reference for AI agents porting Hakkurin to Nest.JS. Dense, factual, exact. All paths relative to repo root; line refs are `file:line`.

Companion docs: [`00-overview.md`](00-overview.md), [`02-ai-system.md`](02-ai-system.md) (brain internals), [`03-nestjs-port-plan.md`](03-nestjs-port-plan.md) (port mapping), [`04-data-security.md`](04-data-security.md), [`05-music-system.md`](05-music-system.md) (music/Navidrome), [`06-webui.md`](06-webui.md) (FastAPI WebUI).

Stack today: Python 3, `discord.py` (`discord.ext.tasks`), a singleton "brain" wrapping NanoGPT-compatible API calls. No ORM, no framework — global-singleton objects imported directly.

---

## 1. Module map

| File | Responsibility | LOC |
|---|---|---|
| `bot/discord_client.py` | Main `HakkurinBot(discord.Client)` — message pipeline, event handlers, 6 background loops, slash-command tree, stealth DMs, sleep mode, memory summarization triggers | 994 |
| `bot/music_manager.py` | Music playback (YouTube/AudioSource queue), skip votes, radio mode, empty-VC disconnect loop | 447 |
| `bot/navidrome_client.py` | Navidrome API client (song/album/artist search) | 143 |
| `bot/navidrome_ui.py` | Discord `NavidromeSearchView` buttons/embeds for Navidrome results | 121 |
| `bot/__init__.py` | Package marker | 0 |
| `core/ai_handler.py` | `brain` singleton — `analyze_interaction`, `generate_response`, `generate_summary`, `generate_holiday_greeting`, `test_api_connection` | 856 |
| `core/config_manager.py` | `config` singleton — JSON config load/get (`allowed_channels`, `reply_probability`, `bot_name`) | 47 |
| `core/conversation_manager.py` | `conversation_manager` singleton — sessions, per-channel context, image buffer, typing-derived activity | 205 |
| `core/memory_manager.py` | `memory` singleton — per-user summaries, temp→permanent queue, self-memory, last-channel tracking, holiday data | 441 |
| `core/scheduler.py` | `scheduler` singleton — parses `SCHEDULED_ACTIONS` JSON from bot self-memory, due-window filtering, action removal | 209 |
| `web/app.py` | Simple web server (Flask-style API surface) | 111 |
| `web/__init__.py` | Package marker | 0 |
| `tools/list_models.py` | Lists available model names (brain helper script) | 32 |
| `tests/debug_ddg.py` | DuckDuckGo-search debug script | 29 |
| `tests/manual_search_test.py` | Manual search test script | 40 |
| `tests/simulate_dm_logging.py` | Simulates DM input/output logging path | 93 |
| `tests/test_ai.py` | `brain` unit tests | 46 |
| `tests/test_config.py` | `config` unit tests | 48 |
| `tests/test_conversation.py` | `conversation_manager` unit tests | 50 |
| `tests/test_dm_memory.py` | DM + memory interaction tests | 115 |
| `tests/test_image_persistence.py` | Image-buffer persistence tests | 69 |
| `tests/test_memory.py` | `memory` unit tests | 64 |
| `tests/verify_new_features.py` | Feature-verification script (largest test file) | 304 |
| `tests/verify_reminder_removal.py` | Verifies `scheduler.remove_executed_actions_from_memory` | 61 |

Verified against `wc -l` at write time. The `__init__.py` files are empty (0 LOC) and are included for completeness; the port may drop them.

---

## 2. Message pipeline (end-to-end)

Entry point: `HakkurinBot.on_message` — `bot/discord_client.py:306`. Steps in order:

1. **Bot filter.** `message.author.bot` → return. `bot/discord_client.py:307`.
2. **Channel whitelist.** If `message.guild is not None` **and** `allowed_channels` is non-empty **and** `channel.id not in allowed_channels` → return. DMs (`message.guild is None`) always pass the whitelist. `bot/discord_client.py:310-313`.
3. **Admin `!sync` prefix command.** Content `== "!sync"` and author has `administrator` → copies global commands to the guild, syncs, replies, then returns (message is never AI-processed). `bot/discord_client.py:320-329`.
4. **`[DM INPUT]` verbose logging.** For `discord.DMChannel`: prints sender name/ID, content, attachment filenames to stdout. `bot/discord_client.py:333-338`.
5. **Session update.** `conversation_manager.create_or_update_session(channel_id, author_id, user_name=display_name, message_content=content)` — creates/updates the `(channel_id, user_id)` session and appends the message to the channel-global context. `bot/discord_client.py:342-347`; `core/conversation_manager.py:107-122`. `was_active = session.is_active` captured **before** triggering. `bot/discord_client.py:350`.
6. **Trigger decision.** `should_process = is_mentioned or is_reply or was_active or is_channel_engaged or is_dm` where:
   - `is_mentioned` — `self.user in message.mentions` (`:353`);
   - `is_reply` — message replies to a cached message authored by the bot (`:354-355`);
   - `is_channel_engaged` — `ChannelContext.is_bot_engaged()` (bot spoke in channel < 60s ago, `core/conversation_manager.py:68-70`) (`:358`);
   - `is_dm` — always true in DMs (`:361`).
   - If not triggered, fallback: `random.random() < reply_probability` (default 0.01) → process. `bot/discord_client.py:365-369`.
7. **Session activation + status.** `session.activate()`; fire-and-forget `update_bot_status("online")`. `bot/discord_client.py:371-376`.
8. **Debounce / interruption cancel.** Iterate `self.pending_tasks` (keyed `(channel_id, user_id) → asyncio.Task`); **cancel every pending task for this channel** (any user) and delete it — implements "cancel if someone keeps typing". `bot/discord_client.py:380-392`.
9. **Immediate memory save.** `save_interaction(user_id, display_name, content, is_bot=False)` in a task — guards against context loss if generation is cancelled. `bot/discord_client.py:396`; `save_interaction` at `:803-824` (adds `"Usuario: {content}"` to the temp memory queue).
10. **Schedule `process_with_debounce`.** New task keyed `(channel.id, author.id)`, stored in `pending_tasks`. `bot/discord_client.py:398-401`.

### `process_with_debounce` — `bot/discord_client.py:403-432`

1. Sleep **5 s** (NanoGPT cost cooldown). `:406`.
2. If the channel has any `typing_users`, poll every 1 s **up to 8 s** for the typing set to empty. `:410-417`.
3. If typing is **still** present after the wait, return without calling the brain (avoids wasted requests). `:421-423`.
4. Else `process_smart_response(message, session)`. `:426`.
5. `asyncio.CancelledError` swallowed; `finally` removes this task from `pending_tasks` if it is the current one. `:428-432`.

### `process_smart_response` — `bot/discord_client.py:434-777`

Context gathering (all passed to the brain):

| Input | Source | Ref |
|---|---|---|
| User memory summary | `memory.get_memory_summary(user_id)` | `:440` |
| Channel history | `ChannelContext.get_formatted_history()` (`core/conversation_manager.py:80-82`) | `:444` |
| Active users (20 min) | `conversation_manager.get_active_users(channel_id, minutes=20)` (`core/conversation_manager.py:124-139`) + explicit non-bot mentions | `:447-451` |
| Image (multimodal) | Attachments downloaded on the spot (`.png/.jpg/.jpeg/.webp`) → `ChannelContext.add_image`; then latest image from buffer via `get_recent_images(seconds=60)`. Only **one** image is forwarded to the brain. | `:455-465`, `:469-478` |
| Current music state | `music_manager.current_song[guild_id]` + `current_album[guild_id]` (skipped in DMs), formatted as `"{title} | Álbum: {album}"` | `:483-491` |
| URL metadata | First URL in message: (a) YouTube → oEmbed API + `img.youtube.com/vi/{id}/hqdefault.jpg` thumbnail; (b) fallback → `yt_dlp.extract_info(download=False)`; (c) final fallback → raw HTML `<title>` + meta description. All network work via `run_in_executor` with 3-5 s timeouts. | `:494-590` |

Then:

1. **`brain.analyze_interaction(user_text, user_id, user_name, context_messages, is_session_active, image_data, image_mime_type, active_user_ids, is_dm, current_playing, url_context)`** → `analysis` dict. `:594-606`. (Contract in §5.)
2. Extract `intent`, `response_content`, `is_talking_to_me`, `reply_to_message_id`, `ping_users`. `:611-615`.
3. **Normalize `response_content` to a list**: strings are wrapped; stringified lists (`"['a','b']"`) are `ast.literal_eval`'d; a second pass flattens nested list-like strings (fixes a visual double-bracket bug). `:621-654`.
4. **Send path** (intent in `["reply", "complain", "new_topic"]` and non-empty content), `:660-768`:
   - `channel.typing()` + initial random `0.5-1.5 s` "reading" delay. `:661-663`.
   - Reply reference: `reply_to_message_id` → `discord.MessageReference(message_id=..., channel_id=...)`; else if talking-to-me and not engaged → reply to the original message. `:668-681`.
   - `ping_users` rendered as `<@{uid}> ` prefix on the **first** public message. `:684-687`, `:711-712`.
   - **Stealth DM extraction** from each message chunk via regex (see §9). `:696`, strip `:704`; if a chunk is only an MD block it is skipped from public send (`:706-708`).
   - Per-chunk typed delay `min(max(len(msg)*0.08, 0.5), 4.0)` s; send with `reference` only on the first chunk; `discord.NotFound` falls back to plain send; `DiscordServerError` (5xx) ignored. `:715-731`.
   - `[DM OUTPUT]` verbose logging in DMs. `:734-737`.
   - Accumulates `full_response_text`; 0.2-0.5 s pause between chunks. `:739-741`.
   - **Delayed stealth DMs**: if `pending_dms`, spawn task that sleeps **3 s** then sends each via `send_stealth_dm`. `:743-749`.
   - Append bot's full reply to channel context, mark bot activity. `:752-754`.
   - **Self-memory**: `memory.log_self_action(full_response_text)`; if it returns "summarize now", spawn `perform_memory_summarization(memory.BOT_SELF_ID)`. `:758-762`.
   - `memory.update_last_channel(user_id, channel.id)` (used by holiday greeter). `:765`.
   - Save bot reply to memory (`is_bot=True`). `:768`.
5. **`intent == "ignore"`** — log and do nothing. `:770-772`.
6. **`intent == "error"`** — critical AI error → `update_bot_status("dnd", ...)` + `enter_sleep_mode(channel)` (see §8). `:774-777`.

---

## 3. Event handlers

| Handler | Ref | Behavior |
|---|---|---|
| `on_ready` | `bot/discord_client.py:237-240` | Print connection; `update_bot_status("idle")` |
| `on_typing` | `bot/discord_client.py:252-276` | Tracks `typing_users[channel_id]` (ignores bots); **cancels every pending AI task in that channel** (the requested typing-cancel); auto-removes the user from the set after 10 s (Discord typing timeout) |
| `on_message` | `bot/discord_client.py:306` | The full pipeline (§2) |

**There is NO `voiceStateUpdate` handler.** Empty-VC cleanup is a background loop: `music_manager.check_empty_voice_channels` (`bot/music_manager.py:105-126`), see §4.

---

## 4. Background `@tasks.loop` jobs

All started in `setup_hook` (`bot/discord_client.py:85-102`); each has a `before_loop` that awaits `wait_until_ready()`.

| Task | Interval | Started at | Purpose |
|---|---|---|---|
| `check_timeouts_task` | 60 s | `:92` (def `:278`) | `conversation_manager.check_timeouts(...)` — expire inactive sessions after 5 min; 12.5% chance the brain says goodbye/complains (max 2 short messages via `send_message_callback` `:295-304`); flips bot status idle/online based on any active session. `core/conversation_manager.py:147-202` |
| `check_holidays_task` | 60 s | `:94` (def `:918`) | GMT-4 clock; fires Christmas (25 Dec 00:01) and New Year (1 Jan 00:00) once per year (persisted in `data/holidays.json`); `celebrate_holiday` (`:962-991`) sends a `brain.generate_holiday_greeting` message + ping to every known user's `last_channel_id`, throttled 2-5 s |
| `process_memory_queue_task` | 60 s | `:96` (def `:899`) | `memory.process_queue()` → temp→permanent + summary candidates; `memory.check_stale_buffers()` (>6 h); summarises each via `perform_memory_summarization` (`:871-882`) |
| `recovery_check_task` | 60 s | `:98` (def `:841`) | Only active while sleeping: after `sleep_until`, probes `brain.test_api_connection()`; healthy → wake + recovery message; still down → sleep 2 more h (§8) |
| `check_reminders_task` | 60 s | `:100` (def `:104-205`) | Reads bot self-memory, `scheduler.parse_scheduled_actions`, `scheduler.check_due_actions`; dedupes via `executed_actions_cache` (1 h TTL); resolves target channel (target user's `last_channel_id` → `last_active_channel_id` → first known); generates the reminder with `brain.generate_response(prompt, user_context_id, user_name)` using the **target user's memory**; falls back to plain text; logs via `memory.log_self_action`; removes executed actions from self-memory (§7) |
| `music_manager.check_empty_voice_channels` | 60 s | `:102` | `bot/music_manager.py:105-126` — for each guild with a queue + voice client: if **no human members** in VC for **≥ 300 s**, clear queue, stop playback, disconnect |

---

## 5. Inter-module contract (MUST PRESERVE in port)

The Discord layer is coupled to the exact return shape of the brain. `core/ai_handler.py` is described in [`02-ai-system.md`](02-ai-system.md); the shape below is what the bot consumes (`bot/discord_client.py:594-615`):

```
analysis = await brain.analyze_interaction(
    user_text: str,
    user_id: str,
    user_name: str,
    context_messages: list[str],
    is_session_active: bool,
    image_data: bytes | None,
    image_mime_type: str | None,
    active_user_ids: list[str],
    is_dm: bool,
    current_playing: str | None,
    url_context: str | None,
) -> {
    "intent": "reply" | "complain" | "new_topic" | "ignore" | "error",
    "response_content": str | list[str],   # bot normalises to list (:621-654)
    "is_talking_to_me": bool,
    "reply_to_message_id": str | None,      # message ID to reply-reference
    "ping_users": list[str],                # user IDs to prefix with <@id>
}
```

- `intent` dispatch: `["reply", "complain", "new_topic"]` → send; `"ignore"` → no-op; `"error"` → sleep mode. `bot/discord_client.py:660`, `:770`, `:774`.
- `response_content` may arrive as a stringified list — the bot defensively normalizes; do not "fix" by changing the brain shape.
- **`brain.generate_response(prompt, user_context_id, user_name) -> str`** is a second public entry point, used for scheduled/reminder responses with a chosen user's memory context. `bot/discord_client.py:187`.
- `brain.generate_summary(current_summary, buffer, user_id, model_name=None) -> str` — memory summarization. `:876`.
- `brain.generate_holiday_greeting(summary, holiday_name) -> str` — holiday messages. `:979`.
- `brain.test_api_connection() -> bool` — sleep-mode recovery probe. `:851`.
- Any change to `analyze_interaction`'s keys or `response_content` type breaks `process_smart_response` — the port must keep this contract or add an adapter at the Discord boundary.

---

## 6. ConversationManager

Singleton `conversation_manager` (`core/conversation_manager.py:84-93`, global at `:205`). Pure in-memory, no persistence.

- **`Session`** (`:9-38`) — key `(channel_id, user_id)`: `last_interaction`, `is_active`, `ignored_count`, personal `context_messages` (pruned to 1 h). `update_interaction()` (`:18`) refreshes time without activating; `activate()` (`:22`) sets active + timestamp.
- **`ChannelContext`** (`:40-82`) — per-channel shared history across users: `messages` (pruned to 1 h / last 50, `:72-78`), `recent_images` (pruned to 5 min, `:77`), `last_bot_activity`. `is_bot_engaged(timeout=60)` (`:68-70`) drives the `is_channel_engaged` trigger. `get_formatted_history()` renders `"{author} (ID: {id}): {content}"` (`:80-82`).
- **`get_session(channel_id, user_id)`** (`:98`) — direct lookup.
- **`get_channel_context(channel_id)`** (`:102`) — lazily creates `ChannelContext`.
- **`create_or_update_session(channel_id, user_id, user_name=None, message_content=None)`** (`:107-122`) — creates session if absent / updates `last_interaction`; if name+content given, adds to channel context **and** the session's personal context.
- **`get_active_users(channel_id, minutes=20)`** (`:124-139`) — author IDs of messages in the last N minutes (deduped, string IDs).
- **`end_session(channel_id, user_id)`** (`:141-145`) — removes the session.
- **`check_timeouts(bot_send_message_callback)`** (`:147-202`) — for each **active** session idle > `SESSION_TIMEOUT` (5 min, `:7`): 87.5% silent timeout; 12.5% builds a `"[SISTEMA]: ..."` prompt, calls `brain.analyze_interaction`, and sends up to 2 messages via the injected async callback `(channel_id, text) -> None`. Always ends the session afterwards.

Public methods used by the bot (`bot/discord_client.py`): `create_or_update_session` (`:342`), `get_channel_context` (`:358`, `:444`, `:752`), `get_active_users` (`:447`), `check_timeouts` (`:281`).

---

## 7. Scheduler

Singleton `scheduler` (`core/scheduler.py:209`). Parses a `SCHEDULED_ACTIONS` JSON array of `{trigger_time, action_description, target_user_id, target_user_name}` embedded in the bot's self-memory text.

- `DUE_WINDOW_SECONDS = 600` (`:7`) — an action fires only within 10 min **after** its `trigger_time` (`0 <= (now - trigger) <= 600`, `:167`).
- **`parse_scheduled_actions(memory_text)`** (`:124-147`) — finds candidate arrays and returns the first that `json.loads` to a list of normalised actions. Candidates via `_find_json_array_candidates` (`:39-75`):
  - priority: fenced ```` ```json [...] ``` ```` blocks (`:43-46`);
  - fallback: **balanced-bracket scanning** from every `[`, string-aware (quotes + escapes), collecting the first balanced `]` (`:48-74`).
- **`_normalize_action(action)`** (`:12-37`) — coerces keys to strings, drops missing `trigger_time`/`action_description`, normalises `target_user_id`/`target_user_name` (`None` when blank).
- **`_find_primary_json_block(memory_text)`** (`:77-97`) — locates the canonical fenced block (or first parseable array) with its `start`/`end` offsets, used for surgical removal.
- **`_parse_trigger_datetime(str)`** (`:99-116`) — accepts `%Y-%m-%d %H:%M[:%S]`, `%Y/%m/%d %H:%M[:%S]`, then `datetime.fromisoformat`.
- **`check_due_actions(actions)`** (`:149-170`) — filters to due actions (10-min window).
- **`build_action_key(action)`** (`:118-122`) — `"{trigger_time}|{target_user_id}|{action_description}"` (lowercased desc); used for the bot's dedupe cache (`bot/discord_client.py:135-139`) and for matching in removal.
- **`remove_executed_actions_from_memory(memory_text, executed_actions)`** (`:172-207`) — parses the primary block, drops executed actions by key, re-serialises the array with `ensure_ascii=False, indent=2`, and splices it back into the text — the **rest of self-memory is preserved**. Called from `check_reminders_task` (`bot/discord_client.py:200-202`) and persisted via `memory.update_summary(memory.BOT_SELF_ID, cleaned, processed_interactions=[])`.

---

## 8. Sleep / error mode

Triggered when `analyze_interaction` returns `intent == "error"` (`bot/discord_client.py:774-777`).

- **`enter_sleep_mode(channel)`** (`:826-839`): `is_sleeping = True`; `sleep_until = now + 7200` (2 h); sends a random "tired" phrase from `data/status_messages.json` (loaded at `:242-249`, defaults `{"tired": ["Me voy a dormir."], "recovery": ["Ya volví."]}`); bot status set to `dnd` / "Error Crítico" (`:776`).
- **`recovery_check_task`** (`:841-869`): every 60 s, if sleeping and past `sleep_until`, probes `brain.test_api_connection()`. Healthy → `is_sleeping = False`, send a random "recovery" phrase to `last_active_channel_id`. Still failing → extend sleep another 2 h silently.
- Memory writes and summarisation continue via the other background tasks; only the interactive brain path is suppressed.

---

## 9. Stealth DM (summary)

Full port mapping in [`03-nestjs-port-plan.md`](03-nestjs-port-plan.md). The bot can send a private DM while the public reply stays clean.

- **Regex** (`bot/discord_client.py:696`): `\[MD:(\d+)\](.*?)(?:\[/MD\]|/MD\]|\[/MD|$)` with `re.IGNORECASE | re.DOTALL`. Matches `[MD:target_id]message[/MD]` and the malformed variants `[/MD]`-dropped `]`, `[`, or end-of-string. The `.*?` is non-greedy so the first closing tag wins.
- **Extraction** (`:696-701`): every match on a response chunk yields `(target_uid, dm_msg)`; appended to `pending_dms`.
- **Strip** (`:704`): `re.sub(r'\[MD:\d+\].*?(?:\[/MD\]|/MD\]|\[/MD|$)', '', msg_text, flags=re.IGNORECASE | re.DOTALL)` removes the tag from the public message; a chunk that becomes empty after stripping is skipped entirely (`:706-708`).
- **Delivery** (`:743-749`): spawned task sleeps **3 s** (after the channel reply), then `send_stealth_dm(message, target_uid, msg)` for each.
- **`send_stealth_dm`** (`:779-801`):
  1. If in a guild: `guild.get_member(int(uid))`, else `guild.fetch_member(int(uid))`.
  2. If still no member (or in a DM context): `fetch_user(int(uid))`.
  3. `target_obj.send(dm_msg)`.
  4. `discord.Forbidden` → log `403` (user closed DMs / no shared server); any other exception → log and swallow. Never crashes the caller.

Secrets note: this file contains no credentials. All tokens/API keys are read from config at runtime; see [`04-data-security.md`](04-data-security.md) for redaction rules.
