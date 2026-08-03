# Hakkurin — Agent Reference Docs

Dense, source-verified reference for AI coding agents. The runtime is **now NestJS/TypeScript**
(port complete — see `03-nestjs-port-plan.md §0` for current status). These docs describe the
**original Python** tree (state, contracts, algorithms with exact `file:line` refs) plus the port
plan and the Google-AI-Studio-only AI migration. The **authoritative guide to the live code is
`CLAUDE.md`** at repo root; these docs are the reference for *why* and *what was ported from*.
Language: English (except `03 §0`, handoff notes in Spanish).

Read in order on first contact:

| # | File | What's in it |
|---|---|---|
| 00 | [`00-overview.md`](00-overview.md) | What Hakkurin is, tech-stack table, `main.py` entry-point flow, annotated repo tree, run instructions (local + Docker), README staleness. |
| 01 | [`01-architecture.md`](01-architecture.md) | Module map + LOC, end-to-end message pipeline, event handlers, 6 background tasks, the `analyze_interaction` contract (MUST PRESERVE), ConversationManager, Scheduler, sleep mode, stealth DM. |
| 02 | [`02-ai-system.md`](02-ai-system.md) | `GeminiBrain` internals — NanoGPT primary + Gemini fallback, multi-key rotation, `web_search` two-pass, intent JSON schema, prompt assembly order, public API. **+ migration to Google AI Studio only.** |
| 03 | [`03-nestjs-port-plan.md`](03-nestjs-port-plan.md) | **§0 = port status + what's left (read first).** Then: target NestJS module tree, Python→TS framework mapping, stealth-DM regex port, `AiBrain` interface, 7 phased steps, security fixes. |
| 04 | [`04-data-security.md`](04-data-security.md) | Config schema, memory schema + Fernet encryption, summarization/queue triggers, scheduler data format, security-debt table, port recommendations. |
| 05 | [`05-music-system.md`](05-music-system.md) | Slash commands, YouTube (`yt-dlp`) path, Navidrome Subsonic client (MD5 auth), per-guild queue state, `play_next`/radio/vote-skip/empty-VC algorithms, UI views. |
| 06 | [`06-webui.md`](06-webui.md) | FastAPI routes, config-form→config-key mapping, end-to-end restart mechanism, templates, security notes, NestJS port target. |

## Conventions
- `file:line` refs are to the Python source at repo root (e.g. `bot/discord_client.py:306`).
- All real secrets are redacted as `<REDACTED>`; keys are described by name only.
- Cross-references use bare filenames (`02-ai-system.md`).
- "MUST PRESERVE" flags a contract the port must not break.
