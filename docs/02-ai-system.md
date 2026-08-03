# 02 — AI System (`core/ai_handler.py`)

Agent-oriented reference for the Hakkurin AI brain. Read alongside:

- `01-architecture.md` — the Discord layer that consumes `analyze_interaction` / `generate_response` (contract consumer).
- `03-nestjs-port-plan.md` — NestJS `AiModule` porting plan.
- `04-data-security.md` — key storage rules. Never log or persist real keys; redact as `<REDACTED>`.

Scope: current state (Section A) and the target state after migrating to Google AI Studio only (Section B).

---

## Section A — CURRENT STATE

### Class, singleton, lifecycle

| Item | Value |
|---|---|
| Class | `GeminiBrain` — `core/ai_handler.py:47` |
| Global singleton | `brain = GeminiBrain()` — `core/ai_handler.py:856` |
| Hot-reload | `GeminiBrain.reload_config()` — `core/ai_handler.py:71-78`; called from `main.py:86` on every restart loop. Re-reads `gemini_keys`, resets `current_key_index`, re-inits both clients. |
| Imports | `google.genai` (`genai`, `types`), `openai.OpenAI`, `core.config_manager.config` — `ai_handler.py:1-7` |

Constructor (`ai_handler.py:48-64`) initializes: key list, rotation index, Gemini client, per-key usage tracking, fallback state (Gemma token budget + `fallback_until`), and the NanoGPT client.

### Provider 1 — NanoGPT (PRIMARY)

Via the `openai` SDK pointed at nano-gpt.com:

| Item | Value |
|---|---|
| Client init | `_initialize_nanogpt_client()` — `ai_handler.py:80-94` |
| Base URL | `https://nano-gpt.com/api/v1` — `ai_handler.py:86` |
| Config key | `nanogpt_api_key` (`config.get("nanogpt_api_key")`) |
| Text model | `deepseek/deepseek-v4-flash:thinking` — `ai_handler.py:199` |
| Vision model | `Qwen/Qwen3.6-35B-A3B:thinking` — `ai_handler.py:219` (switched to when `image_data` present) |
| Generation | `_generate_with_nanogpt(...)` — `ai_handler.py:191-339` (runs SDK call via `asyncio.to_thread`) |
| Params | `temperature=0.7, top_p=0.7, max_tokens=4096, stream=False` — `ai_handler.py:265-268` |

Key detail: `_generate_with_nanogpt` receives `system_prompt=None` from every caller (`analyze_interaction` line 648, `generate_holiday_greeting` line 699, `generate_summary` line 814). The full prompt is passed as the single `user_prompt`; the only time a real `system` message is built is in `generate_response` (`ai_handler.py:850-852`). The tool instructions (`enable_search`) are appended to the system prompt at `ai_handler.py:204-213`.

### Provider 2 — Gemini (FALLBACK)

Via `google-genai` (`genai.Client`). Single client holds the currently-selected key.

| Item | Value |
|---|---|
| Client init | `_initialize_client()` — `ai_handler.py:96-124` |
| Config key | `gemini_keys` — list of up to 6 keys (`config_manager.py:23` default `[]`) |
| Primary models | `["gemini-3-flash-preview", "gemini-2.5-flash"]` — `ai_handler.py:358` |
| Fallback model | `["gemma-3-27b-it"]` — `ai_handler.py:359` |
| Generation | `_generate_with_retry(...)` — `ai_handler.py:352-491` (via `asyncio.to_thread` on `self.client.models.generate_content`) |

### Multi-key rotation + rate limiting

Three cooperating mechanisms:

**1. Per-key usage (`KeyUsage`, `ai_handler.py:14-45`)**

```python
LIMIT_RPM = 5   # requests per minute
LIMIT_RPD = 20  # requests per day
```

`KeyUsage` tracks `requests_today`, `last_reset_day`, `requests_this_minute`, `last_request_time`. `check_and_update()` (lines 21-40) resets daily by day-of-year and per-minute on a simple 60 s window, then returns `(False, reason)` if `LIMIT_RPD`/`LIMIT_RPM` is hit. `register_request()` (lines 42-45) increments counters. Per-key usage is stored in `self.key_usage` keyed by index (`_get_usage`, lines 66-69).

**2. Key selection / rotation**

- `_initialize_client()` (`ai_handler.py:96-124`): starting at `current_key_index`, probes each key with `usage.check_and_update()`; picks the first key that can be used and creates `genai.Client(api_key=...)`. If a key is exhausted, prints `"agotada... Rotando..."` and advances `current_key_index = (current_key_index + 1) % len(self.keys)`. If all keys fail: `self.client = None` (critical error).
- `_rotate_key()` (`ai_handler.py:126-132`): advances `current_key_index` by 1 (mod N) and re-runs `_initialize_client()`.
- `analyze_interaction` registers usage optimistically before calling (`_get_usage(self.current_key_index).register_request()`, line 499); so does `generate_holiday_greeting` (line 671) and `generate_summary` (line 715).

**3. Model fallback + quota handling (`_generate_with_retry`, `ai_handler.py:352-491`)**

Model ordering (`ai_handler.py:361-379`):

- `force_model` set → try only that model.
- `now < self.fallback_until` (set to `time.time() + 2400` = 40 minutes, line 448) → try only `FALLBACK_MODELS`.
- Otherwise → `random.shuffle(PRIMARY_MODELS)`, then `models_to_try = shuffled_primaries + FALLBACK_MODELS`.

Per model (`ai_handler.py:383-485`):

- Gemma special-case: `_check_gemma_limit` (`ai_handler.py:134-143`) enforces a 15 k token/minute budget; if exceeded the model is skipped. After a successful Gemma call, `_update_gemma_usage` (`ai_handler.py:145-146`) adds estimated in+out tokens.
- Up to 2 attempts per model (outer `for attempt in range(2)`, line 403).
- Exception triage (`ai_handler.py:469-485`):
  - Quota (`"429" in error_str or "quota" or "resource_exhausted"`) → `_rotate_key()` and `continue` (retry same model on next key).
  - Model not found (`"404" or "not found"`) → `break` (move to next model).
  - Any other error → `break` (move to next model).
- Gemma does **not** support native JSON mode: when `is_json` and model contains `"gemma"`, a new `types.GenerateContentConfig` is built with `response_mime_type=None` (`ai_handler.py:413-425`), and the text is parsed with `json.loads` after stripping markdown fences (`ai_handler.py:462-465`).
- Empty response → logs `finish_reason` and `safety_ratings` (`ai_handler.py:437-443`).

**NanoGPT vs Gemini selection** — in `analyze_interaction` (`ai_handler.py:645-664`): if `self.nanogpt_client` is truthy, NanoGPT is tried first (`enable_search=True`); only on `None`/exception does it fall back to Gemini `_generate_with_retry`. Identical pattern in `generate_holiday_greeting` (lines 696-708) and `generate_summary` (lines 811-827). So: **NanoGPT is primary, Gemini is fallback** everywhere except `generate_response`, which uses NanoGPT only.

### `web_search` tool-calling (two-pass)

**NanoGPT path only.** The Gemini path (`_generate_with_retry`) has no tool support.

Tool schema (OpenAI format) — `ai_handler.py:238-256`:

```python
tools.append({
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "Busca información en internet. Úsalo para noticias, precios, clima o datos recientes.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "La consulta de búsqueda optimizada para un buscador."
                }
            },
            "required": ["query"]
        }
    }
})
```

Loop (`_generate_with_nanogpt`, lines 258-335):

1. First call with `tools=tools, tool_choice="auto"` (`ai_handler.py:271-279`).
2. If `response_message.tool_calls` present: append the assistant message, then for each tool call with name `web_search`, `json.loads` the arguments, run `self._search_ddg(query)` (`ai_handler.py:289-298`), and append a `role="tool"` message with `tool_call_id`, `name`, `content` (`ai_handler.py:301-306`).
3. Second call with `tools`/`tool_choice` removed from kwargs to force plain text (`ai_handler.py:308-318`); final content taken from `final_response.choices[0].message.content`.

Search executor `_search_ddg(query)` — `ai_handler.py:148-189`:

- Uses `ddgs.DDGS` (DuckDuckGo Search, free).
- Strips `"2025"` from the query (lines 153-155).
- `ddgs.text(query, region='ve-es', max_results=5)` (line 162).
- If `< 2` results and query has >4 words, retries with the first 4 words (lines 172-183).
- Returns `"\n".join(results)` as markdown list, or `"No se encontraron resultados."`.

### Intent analysis (JSON mode)

`analyze_interaction` builds the prompt (`ai_handler.py:571-631`), then sets `response_mime_type="application/json"` (`ai_handler.py:633-638`) and requests structured output. Extracted fields (from the JSON schema embedded in the prompt, `ai_handler.py:605-612`):

```json
{
  "is_talking_to_me": true,
  "intent": "reply" | "ignore" | "complain" | "new_topic",
  "thought_process": "string",
  "response_content": ["string", "string"],
  "reply_to_message_id": "string" | null,
  "ping_users": ["user_id"]
}
```

Decision semantics (personality rules, `ai_handler.py:614-630`):

- `is_talking_to_me` — True if the message targets the bot or is relevant to an active session; else False.
- `intent`:
  - `reply` — respond normally.
  - `ignore` — do nothing (e.g. active session where bot was snubbed).
  - `complain` — call attention when ignored in an active session.
  - `new_topic` — change the subject.
- `reply_to_message_id` — optional Discord reply target.
- `ping_users` — optional list of Discord user IDs to mention.
- Stealth DMs: `response_content` may embed `[MD:USER_ID] ... [/MD]` tags, extracted and hidden from the channel (`ai_handler.py:624`).

Fallbacks:

- Generation failure inside `_generate_with_retry` with `is_json` → `{"intent": "error", "response_content": [f"Error crítico de IA: {last_error}"]}` (`ai_handler.py:490`).
- Both providers fail → `{"intent": "ignore", "response_content": [], "thought_process": "Error de generación"}` (`ai_handler.py:664`).
- On the NanoGPT side, JSON is parsed from raw text after stripping markdown fences (`ai_handler.py:326-333`).

### `_strip_reasoning_tokens`

Static method — `ai_handler.py:341-350`. Removes DeepSeek `<think>...</think>` blocks:

```python
cleaned = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
cleaned = re.sub(r'<think>.*', '', cleaned, flags=re.DOTALL)   # orphaned/truncated
```

Called exactly once, at the end of `_generate_with_nanogpt` (`ai_handler.py:324`). **Only applies to the DeepSeek NanoGPT path.** Confirmed: no Gemini model emits `<think>` blocks, so the method is dead weight after migration.

### Multimodal

- Gemini path: `contents = [text_prompt]`; if `image_data and image_mime_type`, append `types.Part.from_bytes(data=image_data, mime_type=image_mime_type)` (`ai_handler.py:640-643`).
- NanoGPT path: base64 data-URL inside an OpenAI `image_url` content part, and the model switches to the Qwen vision model (`ai_handler.py:216-235`).

### Prompt assembly (`analyze_interaction`, `ai_handler.py:571-631`)

Order of components in `text_prompt` (top → bottom):

1. `system_prompt` — personality from config (`config_manager.py:26`).
2. Developer note — `developer_id` ("Hakka"), daughter-like relationship rules, name "Hakka-sama", profanity permission (`ai_handler.py:573-578`).
3. Current time (`GMT-4`) and bot age (birth date `2025-12-22 02:32 GMT-4`) (`ai_handler.py:509-520`, `580-581`).
4. Session state — `is_session_active`, channel type (DM vs server) (`ai_handler.py:583-585`).
5. Currently playing music/audio (`current_playing`) (`ai_handler.py:586`).
6. Self-memory — `memory.get_self_memory()` (`ai_handler.py:565-566`, `588-589`).
7. Per-user memory summaries — only for active users + current speaker (`memory.get_memory_summary(uid)`, `ai_handler.py:526-537`, `591-592`).
8. Recent channel history — `context_messages` joined by newline (`ai_handler.py:549`).
9. Current message — `user_name`, `user_id`, `user_text` (`ai_handler.py:596-598`).
10. Image flag + URL metadata — `image_data`, `url_context` (`ai_handler.py:599-601`).
11. Task spec — JSON schema + personality/behavior rules (`ai_handler.py:603-630`).

Token budget: `MAX_TOTAL_CHARS = 800_000` (`ai_handler.py:541`). Fixed content (system prompt + profiles + current message) is reserved first; history fills the remainder minus a 5 000 char safety buffer. If history overflows it is truncated by slicing off the oldest bytes and re-aligning to the first newline (`ai_handler.py:543-563`). Priority: System Prompt > Profiles > Current Message > Recent History.

### Public API (contract)

`core/ai_handler.py`:

```python
async def analyze_interaction(self, user_text, user_id, user_name,
                              context_messages=[], is_session_active=False,
                              image_data=None, image_mime_type=None,
                              active_user_ids=None, is_dm=False,
                              current_playing=None, url_context=None)
```

Returns a dict: `{is_talking_to_me, intent, thought_process, response_content, reply_to_message_id, ping_users}`. (line 493)

```python
async def generate_response(self, prompt, user_context_id="hakkurin_internal_self", user_name="Sistema")
```

Returns a plain-text string (line 846). **Currently NanoGPT-only** — builds a system prompt from `user_context_id`/`user_name` and calls `_generate_with_nanogpt`; returns `None` if NanoGPT is absent/fails. This is the scheduled/reminder responder.

Other public methods:

```python
async def generate_holiday_greeting(self, user_summary, holiday_name)   # line 666
async def generate_summary(self, current_summary, recent_interactions, user_id, model_name=None)  # line 710
async def test_api_connection(self)                                     # line 832
```

Related tooling: `tools/list_models.py` lists models visible to the first configured Gemini key via `client.models.list()` — useful to verify the exact available model names during migration.

WebUI key fields: `web/templates/index.html:147-150` (Gemini keys textarea) and `web/templates/index.html:153-156` (NanoGPT key input). Form handling for the NanoGPT field: `web/app.py:42` (`nanogpt_api_key: str = Form("")`), `web/app.py:54-55` (`config.set("nanogpt_api_key", ...)`). Note `nanogpt_api_key` has no entry in the `config_manager.py` defaults (lines 23-28) — it only exists once saved via the WebUI.

---

## Section B — MIGRATION TO GOOGLE AI STUDIO ONLY

Target state: Gemini is the sole provider; NanoGPT/OpenAI/DeepSeek/Qwen are removed. The Discord-facing contract is unchanged.

### Remove

| Item | Location | Notes |
|---|---|---|
| `openai` package | `requirements.txt` | Drop the dependency. |
| `from openai import OpenAI` | `ai_handler.py:7` | |
| `_initialize_nanogpt_client` | `ai_handler.py:80-94` | Delete method + call in `__init__` (line 64) and `reload_config` (line 78). |
| `_generate_with_nanogpt` | `ai_handler.py:191-339` | Delete entire method. |
| `nanogpt_api_key` config key | `web/app.py:42,54-55` | Remove the `Form` field and the `config.set(...)` block. |
| NanoGPT field | `web/templates/index.html:153-156` | Delete the form group. |
| nano-gpt.com base URL | `ai_handler.py:86` | |
| DeepSeek / Qwen models | `ai_handler.py:199,219` | |
| `_strip_reasoning_tokens` | `ai_handler.py:341-350` + call at `ai_handler.py:324` | Confirmed safe to delete: it is only invoked on the NanoGPT/DeepSeek path; no Gemini model emits `<think>` blocks. |
| NanoGPT-first branching | `ai_handler.py:645-656` (`analyze_interaction`), `696-705` (holiday), `811-825` (summary) | Collapse to direct Gemini calls. |

### Gemini becomes the sole provider

- Keep the entire existing rotation machinery and promote it to the **primary** path:
  - `KeyUsage` + limits (`ai_handler.py:14-45`)
  - `_get_usage` (`ai_handler.py:66-69`)
  - `_initialize_client` (`ai_handler.py:96-124`)
  - `_rotate_key` (`ai_handler.py:126-132`)
  - `_check_gemma_limit` / `_update_gemma_usage` (`ai_handler.py:134-146`)
  - `_generate_with_retry` (`ai_handler.py:352-491`)
- Remove the `fallback_until` semantic only insofar as it referenced "primaries failing"; the model-ordering ladder stays (primary models first, Gemma as last-resort).

### Model selection strategy

- Primary: `gemini-2.5-flash` (default) or `gemini-3-flash-preview` once stable. Fallback: `gemma-3-27b-it`.
- Recommend a **configurable model list** in config, e.g.:

```json
"gemini_models": {
  "primary": ["gemini-2.5-flash", "gemini-3-flash-preview"],
  "fallback": ["gemma-3-27b-it"]
}
```

Read it in `_generate_with_retry` instead of the hard-coded `PRIMARY_MODELS`/`FALLBACK_MODELS` at `ai_handler.py:358-359`. Keep the `random.shuffle` of primaries for load balancing (line 378) and the Gemma token-budget guard (lines 386-400, 456-460).

### Preserve (contract must not break)

- `analyze_interaction` signature and return shape exactly (`ai_handler.py:493`) — the Discord layer (`01-architecture.md`) reads `intent`, `response_content`, `is_talking_to_me`, `reply_to_message_id`, `ping_users`.
- `generate_response` signature exactly (`ai_handler.py:846`) — but re-implement its body to call Gemini instead of `_generate_with_nanogpt` (currently it returns `None` without NanoGPT).
- Intent JSON analysis — keep `response_mime_type="application/json"` (`ai_handler.py:637`) and the same field schema.
- Multimodal image input — keep `types.Part.from_bytes(data=image_data, mime_type=image_mime_type)` (`ai_handler.py:643`).
- `web_search` two-pass loop — Gemini supports native function calling; port the tool to a `types.FunctionDeclaration` and use `tools` + `automatic_function_calling` (or the same manual two-pass). This removes the OpenAI-format shim. Reuse `_search_ddg` (`ai_handler.py:148-189`) unchanged.

Gemini function-calling sketch for the port:

```python
from google.genai import types

web_search_decl = types.FunctionDeclaration(
    name="web_search",
    description="Busca información en internet. Úsalo para noticias, precios, clima o datos recientes.",
    parameters=types.Schema(
        type=types.Type.OBJECT,
        properties={
            "query": types.Schema(
                type=types.Type.STRING,
                description="La consulta de búsqueda optimizada para un buscador."
            )
        },
        required=["query"],
    ),
)
```

### Config changes

| Key | Action |
|---|---|
| `nanogpt_api_key` | Drop. Remove from `web/app.py` form handling and the WebUI template. |
| `gemini_keys` | Keep — multi-key rotation is the entire point. `config_manager.py:23`. |
| `gemini_models` (new, recommended) | Model list for the selection ladder (see above). |

### Key rotation design (target)

- **Round-robin** across the N keys in `gemini_keys[]`, advancing `current_key_index = (current_key_index + 1) % N` (already implemented in `_rotate_key`, `ai_handler.py:131`).
- **On 429/rate-limit/resource-exhausted**: mark that key as cooled-down, skip it for a cooldown window, and try the next key. The 429 detection already exists in `_generate_with_retry` (`ai_handler.py:472-480`); the missing piece is a **per-key `cooldown_until` timestamp**.
- **Proposed addition** — extend `KeyUsage` (`ai_handler.py:14-45`) with:

```python
self.cooldown_until = 0  # epoch seconds; skip key while time.time() < cooldown_until
```

and in `check_and_update()` return `(False, "Cooldown active")` when `time.time() < self.cooldown_until`. On a 429, set `usage.cooldown_until = time.time() + 60` (or configurable) before calling `_rotate_key()`. `_initialize_client` (`ai_handler.py:96-124`) then naturally skips cooling-down keys during its probe loop.

### Dependencies (`requirements.txt`)

- **Drop**: `openai`.
- **Keep**: `google-genai`, `ddgs`.
- Unchanged: `discord.py[voice]`, `cryptography`, `fastapi`, `uvicorn`, `python-dotenv`, `jinja2`, `python-multipart`, `yt-dlp`, `PyNaCl`.
