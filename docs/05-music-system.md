# 05 — Music System

Agent-oriented reference for the Hakkurin music subsystem: YouTube playback (`yt-dlp`), Navidrome (Subsonic API) playback, per-guild queue/state, radio auto-queue, vote-skip, empty-VC cleanup, and the Discord UI views. Goal: a Nest.JS porter should almost never need to open the Python source after reading this. All `file:line` refs are to the current Python tree.

Companion docs: [`01-architecture.md`](01-architecture.md), [`03-nestjs-port-plan.md`](03-nestjs-port-plan.md) (full port mapping), [`04-data-security.md`](04-data-security.md) (credential/secret handling).

**Key files**

| File | Role |
|---|---|
| `bot/music_manager.py` (447 lines) | `MusicManager` (state + playback logic), `YTDLSource` (YouTube source), `QueueView` (clear-queue button) |
| `bot/navidrome_client.py` (143 lines) | `NavidromeClient` (Subsonic REST client, MD5-salt auth) + module singleton `navidrome_client` |
| `bot/navidrome_ui.py` (121 lines) | `NavidromeSearchView` (dynamic song/album/artist buttons for `/search` + `/radio`) |
| `bot/discord_client.py` | Slash-command registration (`:39-83`), `!sync` prefix command (`:320-329`), now-playing context for AI (`:482-491`) |

---

## 1. Slash commands

Registered in `HakkurinBot.__init__` (`bot/discord_client.py:39-83`) on `self.tree` (`app_commands.CommandTree`, created at `:36`). Global sync via `self.tree.sync()` in `setup_hook` (`:88`).

| Command | Params | Handler delegate | Source | Registration |
|---|---|---|---|---|
| `/play` | `url: str` ("La URL del video o canción a reproducir") | `music_manager.play(interaction, url)` | **YouTube** (via yt-dlp) | `discord_client.py:39-42` |
| `/skip` | — | `music_manager.skip(interaction)` | vote-skip of current track (either source) | `discord_client.py:44-46` |
| `/stop` | — | `music_manager.stop(interaction)` | stop + disconnect (either source) | `discord_client.py:48-50` |
| `/queue` | — | `music_manager.queue_info(interaction)` | queue embed + `QueueView` | `discord_client.py:52-54` |
| `/search` | `query: str` | `navidrome_client.search(query, limit=5)` → `NavidromeSearchView` (`is_radio=False`) | **Navidrome** | `discord_client.py:60-70` |
| `/radio` | `query: str` | `navidrome_client.search(query, limit=5)` → `NavidromeSearchView` (`is_radio=True`) | **Navidrome** (infinite radio) | `discord_client.py:72-83` |

**`/search` and `/radio` handler detail** (`discord_client.py:62-70`, `:74-83`):
1. `await interaction.response.defer()`.
2. `results = await navidrome_client.search(query, limit=5)`.
3. Build `NavidromeSearchView(music_manager, results, interaction, is_radio=<bool>)` and `view.generate_embed(query)`.
4. If no songs/albums/artists → `followup.send(embed=embed)` (no view). Else `followup.send(embed=embed, view=view)`.
5. `/radio` additionally retitles the embed to `f"📻 Resultados para Radio: {query}"` (`:79`).

**`!sync` prefix command** (`discord_client.py:320-329`) — admin-only text command, not a slash command:
- Guard: `message.content.strip() == "!sync"` and `message.author.guild_permissions.administrator`.
- `self.tree.copy_global_to(guild=message.guild)` then `await self.tree.sync(guild=message.guild)`. Sends confirmation. Non-admins silently ignored (`:321`, early `return`).

**AI integration**: `process_smart_response` reads the now-playing state for the guild (`discord_client.py:482-491`) — `current_song[guild.id]`, plus `current_album[guild.id]` when set and not `"Unknown Album"`, formatted as `f"{song_title} | Álbum: {album}"`, passed as `current_playing` to `brain.analyze_interaction`. Music commands are **not** triggered from `on_message` anymore — comment at `discord_client.py:316-317`.

---

## 2. YouTube path (`bot/music_manager.py`)

### 2.1 Global yt-dlp / ffmpeg config

Global (module-level) dicts, lines `:10-26`:

```python
ytdl_format_options = {
    'format': 'bestaudio/best',
    'outtmpl': '%(extractor)s-%(id)s-%(title)s.%(ext)s',
    'restrictfilenames': True,
    'noplaylist': True,
    'nocheckcertificate': True,
    'ignoreerrors': False,
    'logtostderr': False,
    'quiet': True,
    'no_warnings': True,
    'default_search': 'auto',
    'source_address': '0.0.0.0' # Bind to ipv4 since ipv6 addresses cause issues sometimes
}
ffmpeg_options = {
    'options': '-vn',
    'before_options': '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5' # Necessary for live streams/unstable connection
}
ytdl = yt_dlp.YoutubeDL(ytdl_format_options)  # :28
```

Notes:
- `default_search: 'auto'` means `YTDLSource.from_url` accepts **any URL**, not just YouTube (yt-dlp auto-detects extractor); also makes plain search strings work.
- `-vn` strips video; the `-reconnect*` flags keep live/unstable streams alive (ffmpeg input reconnect).
- `yt_dlp.utils.bug_reports_message` is silenced at `:9`.

### 2.2 `YTDLSource(discord.PCMVolumeTransformer)` — `music_manager.py:30-59`

Constructor:
```python
def __init__(self, source, *, data, volume=0.5):   # :31
    super().__init__(source, volume)
    self.data = data
    self.title = data.get('title')                 # :34
    self.url = data.get('url')                     # :35
```

Classmethod `from_url` (`:37-59`):
```python
@classmethod
async def from_url(cls, url, *, loop=None, stream=False):  # :38
    loop = loop or asyncio.get_event_loop()
    func = functools.partial(ytdl.extract_info, url, download=not stream)  # :43
    data = await loop.run_in_executor(None, func)            # :44  (blocking extract off the event loop)
    if 'entries' in data:
        data = data['entries'][0]                            # :47-49  (playlist -> first entry)
    filename = data['url'] if stream else ytdl.prepare_filename(data)  # :51
    audio_source = discord.FFmpegPCMAudio(filename, **ffmpeg_options)   # :54
    return cls(audio_source, data=data)                      # :56
```

Algorithm:
1. `functools.partial(ytdl.extract_info, url, download=not stream)` (`:43`): `download=True` for non-stream (downloads the file), `download=False` for stream (returns the direct stream URL in `data['url']`).
2. Executed in the default thread executor (`run_in_executor(None, ...)`) so the blocking network/ffmpeg work never blocks the asyncio loop (`:44`).
3. If the result contains `'entries'` (a playlist), take `entries[0]` (`:47-49`) — playlists collapse to their first track.
4. Filename = `data['url']` when streaming (direct URL) else `ytdl.prepare_filename(data)` (downloaded file on disk) (`:51`).
5. Wrap in `discord.FFmpegPCMAudio(filename, **ffmpeg_options)` (`:54`), then return `cls(audio_source, data=data)` — a `PCMVolumeTransformer` subclass so `title`/`url` ride along (`:56`, `:34-35`).
6. On exception, re-raise (caller handles it) (`:57-59`). Debug `print` statements left in place.

Volume default `volume=0.5` (`:31`) — relevant for parity with `@discordjs/voice` `VolumeTransformer` (see `03-nestjs-port-plan.md:267`).

In `play_next`, YouTube items are played as `player = await YTDLSource.from_url(item["url"], loop=self.bot.loop, stream=True)` (`music_manager.py:222`) — always streaming, never downloading.

---

## 3. Navidrome (Subsonic) path (`bot/navidrome_client.py`)

### 3.1 Client config and auth

`NavidromeClient.__init__` (`navidrome_client.py:8-15`):

```python
self.base_url = "http://192.168.1.104:30043/rest"   # :9   internal LAN endpoint
self.external_url = "https://navi.hakkurei.com/rest"  # :10  external/public endpoint
self.username = "<REDACTED>"                        # :11  (was "hakkurin")
self.password = "<REDACTED>"                        # :12  (hardcoded plaintext — see security debt)
self.client_name = "hakkurin-bot"                   # :13
self.version = "1.16.1"                             # :14  -> sent as `v`
self.session = None                                 # :15  lazy aiohttp session
```

Credentials are **hardcoded** at `navidrome_client.py:11-12`; `getCoverArt` URLs are built off `external_url` (`:141`) while all API calls use `base_url`. Both URLs + creds must move to env in the port (`03-nestjs-port-plan.md:255`, `04-data-security.md:169`).

**Auth scheme** — Subsonic MD5-salt, `_get_auth_params` (`:22-32`):
```python
def _get_auth_params(self):
    salt = ''.join(random.choices(string.ascii_letters + string.digits, k=6))  # 6-char alnum salt
    token = hashlib.md5((self.password + salt).encode('utf-8')).hexdigest()
    return {
        "u": self.username,   # user
        "t": token,           # md5(password + salt)
        "s": salt,
        "v": self.version,    # "1.16.1"
        "c": self.client_name,# "hakkurin-bot"
        "f": "json"
    }
```
- `token = md5(password + salt)` where `salt` is 6 random alphanumeric chars regenerated **per request** (`:23`).
- Every call adds `v` (API version) and `c` (client) and `f=json`.

Session: lazily created `aiohttp.ClientSession()` via `_get_session` (`:17-20`), reused, re-created if closed.

### 3.2 Endpoints used

| Method | Subsonic endpoint | Purpose | Params added to auth | Returns | Lines |
|---|---|---|---|---|---|
| `search(query, limit=5)` | `/search3` | query → songs/albums/artists | `query`, `songCount=limit`, `albumCount=limit`, `artistCount=limit` | `subsonic-response.searchResult3` dict (`song`, `album`, `artist` lists) | `:34-50` |
| `get_artist_radio(artist_name, count=20)` | `/search3` | artist → songs for artist radio | `query=artist_name`, `songCount=100`, `albumCount=0`, `artistCount=0` | list of songs | `:52-76` |
| `get_similar_songs(song_ids, count=10)` | `/getSimilarSongs2` | id → similar songs (radio) | `id=<random id from history>`, `count` | list of songs | `:78-102` |
| `get_random_songs(count=10)` | `/getRandomSongs` | random songs (radio fallback) | `size=count` | list of songs | `:104-114` |
| `get_album_songs(album_id)` | `/getAlbum` | album id → full tracklist | `id` | `album.song` list | `:116-126` |
| `get_stream_url(song_id)` | `/stream` | id → playable stream URL | `id` (URL-encoded query string) | URL string | `:128-132` |
| `get_cover_url(cover_id)` | `/getCoverArt` | cover id → 500px cover URL | `id`, `size=500` (external URL) | URL string or `None` | `:134-141` |

All parse `data.get("subsonic-response", {}).get(...)`; on exception they print an error and return `{}` / `[]` (never raise). Responses are JSON via `f=json`.

**URL builders** (`:128-141`) — token leak risk:
```python
def get_stream_url(self, song_id):                    # :128
    params = self._get_auth_params()
    params["id"] = song_id
    query_string = urllib.parse.urlencode(params)
    return f"{self.base_url}/stream?{query_string}"   # :132

def get_cover_url(self, cover_id):                    # :134
    if not cover_id:
        return None                                   # :136
    params = self._get_auth_params()
    params["id"] = cover_id
    params["size"] = 500
    query_string = urllib.parse.urlencode(params)
    return f"{self.external_url}/getCoverArt?{query_string}"  # :141
```
Both embed the full `u`/`t`/`s` auth triplet in the URL. These URLs are then stored in queue items (`_create_song_item`) and — in the case of `cover_url` — sent to Discord as embed thumbnails. The MD5 token is trivially replayable (`04-data-security.md:169`); the port should use short-lived signed tokens and must never log these URLs (`03-nestjs-port-plan.md:257`).

**Singleton**: `navidrome_client = NavidromeClient()` at module bottom (`:143`). Imported lazily inside `_auto_queue_radio` (`music_manager.py:261`) and at module import in `discord_client.py:58`.

### 3.3 Navidrome queue item shape

Every Navidrome track becomes a dict (built by `NavidromeSearchView._create_song_item`, `navidrome_ui.py:32-41`, and re-built identically in `_auto_queue_radio`, `music_manager.py:284-292` and `:301-309`):

```python
{
    "type": "navidrome",
    "url": navidrome_client.get_stream_url(song["id"]),   # stream URL w/ embedded u/t/s
    "id": song["id"],
    "title": song.get("title", "Unknown"),
    "artist": song.get("artist", "Unknown"),
    "album": song.get("album", "Unknown Album"),
    "cover_url": navidrome_client.get_cover_url(song.get("coverArt")),  # may be None
}
```

---

## 4. Per-guild queue state

`MusicManager` stores **all state in dicts keyed by `guild_id`** (`music_manager.py:87-100`). No state lives on the view or client.

| Attribute | Init | Value type / semantics | Line |
|---|---|---|---|
| `self.bot` | passed to `__init__` | the `HakkurinBot` client | `:88` |
| `self.logger` | `logging.getLogger("MusicManager")` | logger | `:90` |
| `self.queues` | `{}` | `guild_id -> list` of items: YouTube item = **string URL** (legacy) or `{"type":"youtube","url":url}` dict; Navidrome item = dict above | `:91` |
| `self.current_song` | `{}` | `guild_id -> str` now-playing title (set `:237`, cleared to `None` when queue empties `:250`) | `:92` |
| `self.skip_votes` | `{}` | `guild_id -> set(user_id)` votes to skip | `:93` |
| `self.empty_vcs` | `{}` | `guild_id -> datetime` (UTC) when channel went empty | `:94` |
| `self.play_history` | `{}` | `guild_id -> list` of last ≤5 played items (song dicts, for radio similarity) | `:95` |
| `self.is_radio_mode` | `{}` | `guild_id -> bool` | `:96` |
| `self.radio_played_ids` | `{}` | `guild_id -> set` of Navidrome song IDs already queued by radio | `:97` |
| `self.is_fetching` | `{}` | `guild_id -> bool` re-entrancy guard for `play_next`/fetch | `:98` |
| `self.current_artist` | `{}` | `guild_id -> str` artist (for LLM context) | `:99` |
| `self.current_album` | `{}` | `guild_id -> str` album (for LLM context) | `:100` |

- `get_queue(guild_id)` (`:132-135`) lazily creates `queues[guild_id] = []` if absent and returns it — the only sanctioned accessor.
- **YouTube item ambiguity**: `play()` enqueues `{"type":"youtube","url":url}` (`:332`); `play_next` handles legacy plain-string URLs by wrapping them (`:201-202`: `if isinstance(item, str): item = {"type": "youtube", "url": item}`).
- `skip_votes` are cleared at the start of each new track (`:178-179`) and on `stop` (`:405-406`).

---

## 5. Playback flow — `play_next(guild, channel)` — `music_manager.py:164-258`

Signature: `async def play_next(self, guild, channel)`. `guild` is the `discord.Guild`, `channel` the text channel for status messages.

Step-by-step algorithm:

1. **Re-entrancy guard** (`:167-168`): if `self.is_fetching.get(guild_id, False)` → return immediately (no concurrent fetch).
2. **Already playing guard** (`:170-171`): if `guild.voice_client` and `.is_playing()` → return.
3. **Set `is_fetching[guild_id] = True`** (`:173`), wrapped in `try/finally` so it is always reset (`:258`).
4. `queue = self.get_queue(guild_id)` (`:175`).
5. **Clear skip votes** for the new song (`:178-179`).
6. **Radio pre-fetch** (only when `is_radio_mode[guild_id]` is truthy, `:182-189`):
   - `len(queue) == 0` → `await self._auto_queue_radio(guild_id, channel)` then re-read `queue` (`:183-186`).
   - `len(queue) <= 2` → fire `self.bot.loop.create_task(self._auto_queue_radio(...))` in the **background** (`:187-189`).
7. **Pop next item** if `len(queue) >= 1` (`:191-192`): `item = queue.pop(0)`.
8. **Record play history** (`:194-199`): append `item` to `play_history[guild_id]` (init `[]`), cap at **5** (pop oldest when `> 5`).
9. **Normalize YouTube string items** to `{"type":"youtube","url":item}` (`:201-202`).
10. **Build the player**:
    - Navidrome item (`item.get("type") == "navidrome"`, `:204-220`):
      - `stream_url = item["url"]`, title/artist/album extracted with defaults (`:206-208`).
      - `audio_source = discord.PCMVolumeTransformer(discord.FFmpegPCMAudio(stream_url, **ffmpeg_options), volume=0.5)` (`:210`).
      - `display_title = f"{artist} - {title}"` unless artist is `"Unknown Artist"` (`:213`); assigned to `audio_source.title` (`:214`).
      - Persist `self.current_artist[guild_id] = artist`, `self.current_album[guild_id] = album` for the LLM (`:217-218`).
      - `player = audio_source` (`:220`).
    - Else (YouTube, `:221-222`): `player = await YTDLSource.from_url(item["url"], loop=self.bot.loop, stream=True)`.
11. **Wait for voice connection** if absent/broken (the 4017-reconnect case, `:224-229`): poll `guild.voice_client.is_connected()` every 1 s up to 30 s.
12. **Verify connected** (`:231-248`):
    - If `.is_playing()` already true (another task won the race) → **re-queue**: `queue.insert(0, item)` and return (`:232-235`).
    - Else start playback: `guild.voice_client.play(player, after=lambda e: asyncio.run_coroutine_threadsafe(self.play_next(guild, channel), self.bot.loop))` (`:236`) — **this `after` callback is the recursion that advances the queue** on track end (or error). `run_coroutine_threadsafe` marshals the coroutine onto the bot loop because `after` fires from a non-async thread.
    - Set `self.current_song[guild_id] = getattr(player, 'title', item.get("title", "Unknown"))` (`:237`).
    - **Now-playing message** (`:239-245`): if Navidrome item **and** `item.get("cover_url")` → `discord.Embed(title="🎶 Reproduciendo ahora", description=f"**{self.current_song[guild_id]}**", color=discord.Color.blue())`, `embed.set_thumbnail(url=item["cover_url"])`, footer `"Hakkurei Music"` (`:240-243`). Else plain text `f'🎶 Reproduciendo ahora: **{self.current_song[guild_id]}**'` (`:245`).
    - If not connected → log warning and `raise Exception("No se pudo establecer o mantener la conexión de voz.")` (`:247-248`).
13. **Queue empty** (`:249-250`): set `self.current_song[guild_id] = None` (also leaves `current_artist`/`current_album` as-is).
14. **Error path** (`:251-256`): log `"Error reproduciendo música"`, send error text to channel, reset `is_fetching[guild_id] = False`, and **recursively call `play_next` again** to try the next item.
15. `finally: self.is_fetching[guild_id] = False` (`:258`).

### Entry points

- `play(interaction, url)` (`:315-339`): defers if needed → joins VC if absent (`:321-323`, via `join_voice_channel`) → disables radio (`is_radio_mode[guild.id] = False`, clears `radio_played_ids`, `:326-328`) → appends `{"type":"youtube","url":url}` (`:332`) → if not playing and not fetching, awaits `play_next` and replies `▶️ Iniciando reproducción...`; else replies `✅ Añadido a la cola: <url>` (`:335-339`).
- `play_navidrome_items(interaction, songs)` (`:341-358`): defers → joins VC → appends each song dict (`:350-351`) → if not playing/not fetching, awaits `play_next` and replies `▶️ Iniciando reproducción de Navidrome...`; else replies with count (`"1 canción"` vs `"N canciones"`, `:357`).

---

## 6. Radio auto-queue — `_auto_queue_radio(guild_id, channel)` — `music_manager.py:260-313`

Infinite-mode radio. Step-by-step:

1. Lazy-import the singleton: `from bot.navidrome_client import navidrome_client` (`:261`).
2. `history = self.play_history.get(guild_id, [])` (`:262`).
3. Collect Navidrome IDs from history: `navidrome_ids = [item["id"] for item in history if isinstance(item, dict) and item.get("type") == "navidrome" and item.get("id")]` (`:263`).
4. `songs = await navidrome_client.get_similar_songs(navidrome_ids, count=10)` (`:265`) — `get_similar_songs` itself falls back to random when ids empty, when the API returns nothing, or on error (`navidrome_client.py:79-80, 94-96, 100-102`).
5. If `songs` empty → `songs = await navidrome_client.get_random_songs(count=10)` (`:267-268`); if still empty → `return` (`:270-271`).
6. `queue = self.get_queue(guild_id)` (`:273`); init `radio_played_ids[guild_id] = set()` if absent (`:275-276`).
7. **Dedupe loop** (`:279-293`): for each song, skip if `song["id"] in radio_played_ids` (`:280-281`); else add id to the set and append a full Navidrome item (same shape as §3.3) to the queue (`:284-292`). `cover_url` built from `song.get("coverArt")`.
8. **All-exhausted fallback** (`:296-310`): if `added_count == 0` (every similar song already played), `clear()` the `radio_played_ids` set, fetch `get_random_songs(count=10)`, add each to the set + queue (same item shape), incrementing `added_count`.
9. If `added_count > 0`, send `f"📻 *Radio: Añadidas {added_count} canciones en la cola.*"` (`:312-313`).

Combined with §5 step 6, the mode is **infinite**: whenever the queue runs low, more songs are pre-fetched from history-similar or random Navidrome tracks. Radio is entered via `/radio` callbacks setting `is_radio_mode[guild_id] = True` and resetting `radio_played_ids[guild_id] = set()` (`navidrome_ui.py:56-58, 68-70, 81-83`); disabled by `/play` (`:326-328`) and `/stop` (`:399-401`).

---

## 7. Vote-skip — `skip(interaction)` — `music_manager.py:360-394`

1. `await interaction.response.defer()` (`:361`).
2. Guards: no voice client or not playing → `"No hay nada reproduciéndose."` ephemeral (`:363-365`); requester not in the same VC as the bot (`interaction.user.voice.channel != guild.voice_client.channel`) → `"Debes estar en el mismo canal de voz para saltar la canción."` ephemeral (`:367-370`).
3. **Quorum**: `channel_members = guild.voice_client.channel.members`; `humans = [m for m in channel_members if not m.bot]` (`:373-375`); `total_votes_needed = (len(humans) // 2) + 1` (`:376`) — i.e. majority of **human** listeners.
4. Init `skip_votes[guild.id] = set()` if absent (`:379-380`).
5. If `interaction.user.id` not already in the set (`:383`):
   - Add the vote; `current_votes = len(set)` (`:384-385`).
   - `current_votes >= total_votes_needed` → `guild.voice_client.stop()` (the `after=` callback in `play_next` fires → next track starts), send `"⏭️ ¡Votación completada! Saltando canción."`, clear the set (`:387-390`).
   - Else send `f"🗳️ Voto registrado ({current_votes}/{total_votes_needed})."` (`:392`).
6. Duplicate vote → `"¡Ya has votado para saltar!"` ephemeral (`:393-394`).

**Single-listener auto-skip**: with 1 human, `(1 // 2) + 1 = 1`, so the first vote skips immediately.

---

## 8. `join_voice_channel(interaction)` — `music_manager.py:137-162`

1. If `interaction.user.voice` is falsy → ephemeral error `"¡Necesitas estar en un canal de voz para que pueda poner música!"` (respects `interaction.response.is_done()`: followup vs send_message, `:156-161`) and return `False`.
2. `channel = interaction.user.voice.channel` (`:139`).
3. If `interaction.guild.voice_client` exists → `await ...move_to(channel)`; else `await channel.connect()` (`:140-143`).
4. **Connection-wait poll** (`:146-149`): while `voice_client.is_connected()` is `False` and `wait_time < 30`, sleep `0.5` s and increment. Explicit validation of the WS/voice handshake.
5. **UDP settle sleep**: `await asyncio.sleep(1.0)` (`:153`) — comment explains this prevents the "audio at 2x speed" desync/catch-up when joining.
6. Return `True`.

`play_next` repeats the same 30 s `is_connected` poll before starting a track (`:227-229`) — see §5 step 11. Port note: `@discordjs/voice` handles connect differently; verify on a real guild (`03-nestjs-port-plan.md:268`).

---

## 9. Empty-VC cleanup — `check_empty_voice_channels` — `music_manager.py:105-130`

Background `@tasks.loop(minutes=1)` (`:105`), started in `setup_hook` (`discord_client.py:102`) and cancelled in `cog_unload` (`music_manager.py:102-103`). `before_loop` awaits `bot.wait_until_ready()` (`:128-130`).

Per tick, for each `guild_id in list(self.queues.keys())` (`:107`):
1. Resolve `guild = self.bot.get_guild(guild_id)`; require `guild` and `guild.voice_client` (`:108-109`).
2. `channel_members = [m for m in guild.voice_client.channel.members if not m.bot]` (`:110`).
3. **If no humans**:
   - If `guild_id not in self.empty_vcs` → record `self.empty_vcs[guild_id] = discord.utils.utcnow()` (start the clock) (`:112-113`).
   - Else if elapsed `>= 300` s (5 min) (`:115`): `queues[guild_id].clear()`, `skip_votes.pop(guild_id, None)`, `empty_vcs.pop(guild_id, None)`, `voice_client.stop()` if playing, `await voice_client.disconnect()`, log `"Disconnected from {guild.name} due to inactivity."` (`:116-122`).
4. **If humans present** → `self.empty_vcs.pop(guild_id, None)` (reset the clock) (`:123-124`).
5. If no `voice_client` at all → also pop the timestamp (`:126`).

Note: `current_song`, `play_history`, `is_radio_mode`, `radio_played_ids`, `current_artist`, `current_album`, `is_fetching` are **not** cleared on disconnect — only queue, votes, and empty-`vc` timestamp.

---

## 10. UI views

### 10.1 `QueueView(discord.ui.View)` — `music_manager.py:61-85`

- `__init__(music_manager, guild_id)`, `super().__init__(timeout=120)` (`:62-65`).
- One button: `@discord.ui.button(label="Limpiar Cola", style=discord.ButtonStyle.danger, emoji="🗑️")` → `async def clear_queue(self, interaction, button)` (`:67-68`).
- **Permission check**: `interaction.user.guild_permissions.administrator` required, else ephemeral `"❌ Solo los administradores pueden limpiar la cola."` (`:69-71`).
- If `guild_id in music_manager.queues` → `queues[guild_id].clear()` + `"✅ La cola de reproducción ha sido limpiada."`; else `"La cola ya está vacía."` ephemeral (`:73-77`).
- Disables all buttons and edits the message to persist (`:79-85`).
- Attached only by `queue_info` (`:446-447`).

### 10.2 `queue_info(interaction)` — `music_manager.py:416-447`

- `queue = self.get_queue(guild_id)`; `current = self.current_song.get(guild_id, "Nada")` (`:418-419`).
- Empty → `"La cola está vacía."` (`:421-423`).
- `discord.Embed(title="🎶 Cola de Reproducción", color=discord.Color.blue())` (`:425`).
- Field `"Reproduciendo ahora:"` = `current` when set (`:426-427`).
- Field `"En cola:"` lists **first 10** items with `\`{i+1}.\` title` lines (`:430-439`); item title resolution: string → itself; dict → `item.get("title", item.get("url", "Unknown"))`, prefixed `f"{item['artist']} - {title}"` when artist is set and not `"Unknown Artist"`/`"Unknown"` (`:432-437`). If `len(queue) > 10` → footer line `f"\n*...y {len(queue) - 10} canciones más.*"` (`:441-442`).
- Sends with `view = QueueView(self, guild_id)` (`:446-447`).

### 10.3 `NavidromeSearchView(discord.ui.View)` — `navidrome_ui.py:4-121`

`__init__(music_manager, search_results, original_interaction, is_radio=False)`, `super().__init__(timeout=120)` (2-minute timeout, `:6`). Stores `music_manager`, `search_results`, `original_interaction`, `is_radio`.

**Button grid** (`:12-30`) — capped at first 5 of each result category:

| Row | Category | Emoji | `custom_id` | Callback | Count source |
|---|---|---|---|---|---|
| 0 | Songs | 🎵 | `song_{idx}` | `song_callback` | `search_results['song'][:5]` |
| 1 | Albums | 💿 | `album_{idx}` | `album_callback` | `search_results['album'][:5]` |
| 2 | Artists | 👤 | `artist_{idx}` | `artist_callback` | `search_results['artist'][:5]` |

Buttons carry `label=str(idx+1)`. `custom_id` encodes the index; callbacks parse it with `int(interaction.data["custom_id"].split("_")[1])` (`:53, :64, :79`).

**`_create_song_item(song)`** (`:32-41`) — builds the Navidrome queue dict (shape in §3.3) via `navidrome_client.get_stream_url(song["id"])` and `get_cover_url(song.get("coverArt"))`.

**Callbacks**:
- `song_callback(interaction)` (`:51-60`): defer → parse idx → `song = self.songs[idx]` → `item = self._create_song_item(song)`. If `is_radio`: set `is_radio_mode[guild.id] = True` and `radio_played_ids[guild.id] = set()`. Then `await self.music_manager.play_navidrome_items(interaction, [item])` and `await self._disable_all()`.
- `album_callback(interaction)` (`:62-75`): defer → parse idx → `album = self.albums[idx]` → **fetch full tracklist first**: `album_songs = await navidrome_client.get_album_songs(album["id"])` → `items = [self._create_song_item(s) for s in album_songs]`. If `is_radio`, set radio mode + reset ids. If items → `play_navidrome_items(interaction, items)`, else ephemeral `"No se encontraron canciones en este álbum."`. `_disable_all()`.
- `artist_callback(interaction)` (`:77-85`): defer → parse idx → `artist = self.artists[idx]`. If `is_radio`, set radio mode + reset ids. `await self._play_radio_for_artist(interaction, artist["name"])` then `_disable_all()`.
- `_play_radio_for_artist(interaction, artist_name)` (`:43-49`): `artist_songs = await navidrome_client.get_artist_radio(artist_name, count=20)` → items → `play_navidrome_items(interaction, items)`; if no items, ephemeral `"No se encontraron canciones para el artista: {artist_name}"`.

**`_disable_all()`** (`:87-95`): sets `disabled = True` on every child button, edits the **original** interaction response message (`self.original_interaction.original_response()`), then `self.stop()`.

**`generate_embed(query)`** (`:97-121`): `discord.Embed(title=f"🔍 Resultados de Navidrome para: {query}", color=discord.Color.green())`. Adds fields: `🎵 Canciones` (`` `{i+1}.` {title} - {artist} ``), `💿 Álbumes` (`` `{i+1}.` {name} - {artist} ``), `👤 Artistas` (`` `{i+1}.` {name} ``), each `inline=False`. If all three empty → `embed.description = "No se encontraron resultados."`.

---

## 11. Port notes (brief)

Full mapping lives in `03-nestjs-port-plan.md:97-100, 225-229, 265-268`.

| Python | NestJS target | Notes |
|---|---|---|
| `discord.FFmpegPCMAudio` + `yt_dlp` (`music_manager.py:30-59, 210, 222`) | `@discordjs/voice` `AudioPlayer` + `createAudioResource` + `play-dl`/`ytdl-core` | `AudioPlayer` idle/failed events replace the hand-rolled `is_fetching` guard (`:167-173, 255-258`) and the `after=` recursion (`:236`). Reconnect flags → `createAudioResource(input, { inlineVolume: true })`; `PCMVolumeTransformer` → `VolumeTransformer` (`03-nestjs-port-plan.md:99`). |
| `NavidromeClient` aiohttp + MD5-salt (`navidrome_client.py:17-141`) | NestJS `HttpService` (axios) or native `fetch` provider | **KEEP** `token = md5(password + salt)` with 6-char random alnum salt; map `search3`/`getSimilarSongs2`/`getRandomSongs`/`getAlbum`/`stream`/`getCoverArt` (`:34-141`). |
| Per-guild dicts (`music_manager.py:91-100`) | `Map<string, GuildMusicState>` in `MusicService` | One state object per guild instead of 10 parallel dicts. |
| `QueueView` + `NavidromeSearchView` (`music_manager.py:61-85`, `navidrome_ui.py:4-95`) | discord.js Components V2 (action rows + buttons), `custom_id` = `song_{idx}` rows 0-2 | `MessageComponentCollector` or necord `@Component` handlers; disable buttons after use. |
| `check_empty_voice_channels` loop (`music_manager.py:105-130`) | `@nestjs/schedule` `@Interval()`/`@Cron()` | 1-min tick, 300 s human-empty threshold. |

**Risks / decisions**:
- **yt-dlp has no direct JS equivalent.** `play-dl`/`ytdl-core` break more often than `yt_dlp` (YouTube anti-bot). Consider a **sidecar yt-dlp HTTP service** (Python container exposing `/extract?url=`) called by `MusicModule` (`03-nestjs-port-plan.md:265`).
- **Navidrome token-in-URL leak**: `get_stream_url`/`get_cover_url` embed `u`/`t`/`s` (`navidrome_client.py:128-141`). Prefer short-lived signed tokens; never log these URLs (`03-nestjs-port-plan.md:257`).
- **Credential + base URLs hardcoded** at `navidrome_client.py:9-13` → move to env via `ConfigService` (`04-data-security.md:169, 184`).
- **Voice-connect stabilization**: 30 s poll + 1 s UDP settle (`music_manager.py:146-153, 227-230`) exist to avoid the "audio at 2x" bug; `joinVoiceChannel` differs — verify on a real guild (`03-nestjs-port-plan.md:268`).
