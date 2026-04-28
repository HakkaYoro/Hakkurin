import discord
import asyncio
import yt_dlp
import logging
import urllib.parse
import functools
from discord.ext import tasks
# Configuración de yt-dlp
yt_dlp.utils.bug_reports_message = lambda *args, **kwargs: ''
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

ytdl = yt_dlp.YoutubeDL(ytdl_format_options)

class YTDLSource(discord.PCMVolumeTransformer):
    def __init__(self, source, *, data, volume=0.5):
        super().__init__(source, volume)
        self.data = data
        self.title = data.get('title')
        self.url = data.get('url')

    @classmethod
    async def from_url(cls, url, *, loop=None, stream=False):
        print(f"DEBUG: Starting from_url for {url}")
        loop = loop or asyncio.get_event_loop()
        try:
            print("DEBUG: Calling extract_info...")
            func = functools.partial(ytdl.extract_info, url, download=not stream)
            data = await loop.run_in_executor(None, func)
            print("DEBUG: extract_info finished.")

            if 'entries' in data:
                # take first item from a playlist
                data = data['entries'][0]

            filename = data['url'] if stream else ytdl.prepare_filename(data)
            print(f"DEBUG: Filename determined: {filename}")
            print(f"DEBUG: Creating FFmpegPCMAudio with options: {ffmpeg_options}")
            audio_source = discord.FFmpegPCMAudio(filename, **ffmpeg_options)
            print("DEBUG: FFmpegPCMAudio created.")
            return cls(audio_source, data=data)
        except Exception as e:
            print(f"DEBUG: Error in from_url: {e}")
            raise e

class QueueView(discord.ui.View):
    def __init__(self, music_manager, guild_id):
        super().__init__(timeout=120)
        self.music_manager = music_manager
        self.guild_id = guild_id

    @discord.ui.button(label="Limpiar Cola", style=discord.ButtonStyle.danger, emoji="🗑️")
    async def clear_queue(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Solo los administradores pueden limpiar la cola.", ephemeral=True)
            return
            
        if self.guild_id in self.music_manager.queues:
            self.music_manager.queues[self.guild_id].clear()
            await interaction.response.send_message("✅ La cola de reproducción ha sido limpiada.")
        else:
            await interaction.response.send_message("La cola ya está vacía.", ephemeral=True)
            
        # Disable button
        for item in self.children:
            item.disabled = True
        try:
            await interaction.message.edit(view=self)
        except Exception:
            pass

class MusicManager:
    def __init__(self, bot):
        self.bot = bot
        self.logger = logging.getLogger("MusicManager")
        self.queues = {} # guild_id -> list of urls/titles
        self.current_song = {} # guild_id -> current song title
        self.skip_votes = {} # guild_id -> set(user_id)
        self.empty_vcs = {} # guild_id -> timestamp
        self.play_history = {} # guild_id -> list of song dicts
        self.is_radio_mode = {} # guild_id -> bool
        self.radio_played_ids = {} # guild_id -> set
        self.is_fetching = {} # guild_id -> bool

    def cog_unload(self):
        self.check_empty_voice_channels.cancel()

    @tasks.loop(minutes=1)
    async def check_empty_voice_channels(self):
        for guild_id in list(self.queues.keys()):
            guild = self.bot.get_guild(guild_id)
            if guild and guild.voice_client:
                channel_members = [m for m in guild.voice_client.channel.members if not m.bot]
                if not channel_members:
                    if guild_id not in self.empty_vcs:
                        self.empty_vcs[guild_id] = discord.utils.utcnow()
                    else:
                        if (discord.utils.utcnow() - self.empty_vcs[guild_id]).total_seconds() >= 300:
                            self.queues[guild_id].clear()
                            self.skip_votes.pop(guild_id, None)
                            self.empty_vcs.pop(guild_id, None)
                            if guild.voice_client.is_playing():
                                guild.voice_client.stop()
                            await guild.voice_client.disconnect()
                            self.logger.info(f"Disconnected from {guild.name} due to inactivity.")
                else:
                    self.empty_vcs.pop(guild_id, None)
            else:
                 self.empty_vcs.pop(guild_id, None)

    @check_empty_voice_channels.before_loop
    async def before_check_empty_voice_channels(self):
        await self.bot.wait_until_ready()

    def get_queue(self, guild_id):
        if guild_id not in self.queues:
            self.queues[guild_id] = []
        return self.queues[guild_id]

    async def join_voice_channel(self, interaction):
        if interaction.user.voice:
            channel = interaction.user.voice.channel
            if interaction.guild.voice_client is not None:
                await interaction.guild.voice_client.move_to(channel)
            else:
                await channel.connect()
                
            # Validar explícitamente que el estado de conexión al VC sea exitoso
            wait_time = 0
            while interaction.guild.voice_client and getattr(interaction.guild.voice_client, "is_connected", lambda: False)() == False and wait_time < 30:
                await asyncio.sleep(0.5)
                wait_time += 1

            # Pequeña pausa para permitir que la conexión UDP y el socket de voz se estabilicen, 
            # previniendo el efecto de "audio a 2x de velocidad" (desfase/catch-up) al unirse.
            await asyncio.sleep(1.0)
            
            return True
        else:
            msg = "¡Necesitas estar en un canal de voz para que pueda poner música!"
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)
            return False

    async def play_next(self, guild, channel):
        guild_id = guild.id
        
        if self.is_fetching.get(guild_id, False):
            return
            
        if guild.voice_client and guild.voice_client.is_playing():
            return

        self.is_fetching[guild_id] = True
        try:
            queue = self.get_queue(guild_id)
            
            # Clear skip votes when song changes
            if guild_id in self.skip_votes:
                self.skip_votes[guild_id].clear()

            # Infinite Radio Logic
            if self.is_radio_mode.get(guild_id, False):
                if len(queue) == 0:
                    # Queue empty - await new songs before continuing
                    await self._auto_queue_radio(guild_id, channel)
                    queue = self.get_queue(guild_id)
                elif len(queue) <= 2:
                    # Queue running low - pre-fetch in background
                    self.bot.loop.create_task(self._auto_queue_radio(guild_id, channel))

            if len(queue) >= 1:
                item = queue.pop(0)
                
                # Record in play history
                if guild_id not in self.play_history:
                    self.play_history[guild_id] = []
                self.play_history[guild_id].append(item)
                if len(self.play_history[guild_id]) > 5:
                    self.play_history[guild_id].pop(0)
                    
                if isinstance(item, str):
                    item = {"type": "youtube", "url": item}
                    
                if item.get("type") == "navidrome":
                    stream_url = item["url"]
                    title = item.get("title", "Navidrome Stream")
                    artist = item.get("artist", "Unknown Artist")
                    
                    audio_source = discord.PCMVolumeTransformer(discord.FFmpegPCMAudio(stream_url, **ffmpeg_options), volume=0.5)
                    audio_source.title = f"{artist} - {title}" if artist != "Unknown Artist" else title
                    player = audio_source
                else:
                    player = await YTDLSource.from_url(item["url"], loop=self.bot.loop, stream=True)
                    
                if guild.voice_client:
                    # Esperamos a que termine de conectarse si estaba reintentando por error 4017
                    wait_time = 0
                    while guild.voice_client and getattr(guild.voice_client, "is_connected", lambda: False)() == False and wait_time < 30:
                        await asyncio.sleep(1)
                        wait_time += 1
                        
                    if getattr(guild.voice_client, "is_connected", lambda: False)():
                        if guild.voice_client.is_playing():
                            # Already playing, likely from another task. Stop here and re-queue.
                            queue.insert(0, item)
                            return
                        guild.voice_client.play(player, after=lambda e: asyncio.run_coroutine_threadsafe(self.play_next(guild, channel), self.bot.loop))
                        self.current_song[guild_id] = getattr(player, 'title', item.get("title", "Unknown"))
                        
                        if item.get("type") == "navidrome" and item.get("cover_url"):
                            embed = discord.Embed(title="🎶 Reproduciendo ahora", description=f"**{self.current_song[guild_id]}**", color=discord.Color.blue())
                            embed.set_thumbnail(url=item["cover_url"])
                            embed.set_footer(text="Hakkurei Music")
                            await channel.send(embed=embed)
                        else:
                            await channel.send(f'🎶 Reproduciendo ahora: **{self.current_song[guild_id]}**')
                    else:
                        self.logger.warning("Voice client disappeared or failed to connect during play_next.")
                        raise Exception("No se pudo establecer o mantener la conexión de voz.")
            else:
                self.current_song[guild_id] = None
        except Exception as e:
            self.logger.error(f"Error reproduciendo música: {e}")
            await channel.send(f"Ocurrió un error al intentar reproducir la canción o conectarse al canal de voz: {str(e)}")
            # Try next one by releasing lock and calling play_next again
            self.is_fetching[guild_id] = False
            await self.play_next(guild, channel)
        finally:
            self.is_fetching[guild_id] = False

    async def _auto_queue_radio(self, guild_id, channel):
        from bot.navidrome_client import navidrome_client
        history = self.play_history.get(guild_id, [])
        navidrome_ids = [item["id"] for item in history if isinstance(item, dict) and item.get("type") == "navidrome" and item.get("id")]
        
        songs = await navidrome_client.get_similar_songs(navidrome_ids, count=10)
        
        if not songs:
            songs = await navidrome_client.get_random_songs(count=10)
        
        if not songs:
            return
            
        queue = self.get_queue(guild_id)
        
        if guild_id not in self.radio_played_ids:
            self.radio_played_ids[guild_id] = set()
            
        added_count = 0
        for song in songs:
           if song["id"] in self.radio_played_ids[guild_id]:
               continue
               
           self.radio_played_ids[guild_id].add(song["id"])
           queue.append({
                "type": "navidrome",
                "url": navidrome_client.get_stream_url(song["id"]),
                "id": song["id"],
                "title": song.get("title", "Unknown"),
                "artist": song.get("artist", "Unknown"),
                "cover_url": navidrome_client.get_cover_url(song.get("coverArt"))
           })
           added_count += 1
        
        # Si todas las canciones ya fueron reproducidas, resetear y obtener aleatorias
        if added_count == 0:
            self.radio_played_ids[guild_id].clear()
            random_songs = await navidrome_client.get_random_songs(count=10)
            for song in random_songs:
                self.radio_played_ids[guild_id].add(song["id"])
                queue.append({
                    "type": "navidrome",
                    "url": navidrome_client.get_stream_url(song["id"]),
                    "id": song["id"],
                    "title": song.get("title", "Unknown"),
                    "artist": song.get("artist", "Unknown"),
                    "cover_url": navidrome_client.get_cover_url(song.get("coverArt"))
                })
                added_count += 1
           
        if added_count > 0:
            await channel.send(f"📻 *Radio: Añadidas {added_count} canciones en la cola.*")

    async def play(self, interaction, url):
        # Defer response first since extracting/connecting takes time
        if not interaction.response.is_done():
            await interaction.response.defer()
            
        # Join channel if not already in one
        if not interaction.guild.voice_client:
            if not await self.join_voice_channel(interaction):
                return

        # Disable radio mode for manual plays
        self.is_radio_mode[interaction.guild.id] = False
        if interaction.guild.id in self.radio_played_ids:
            self.radio_played_ids[interaction.guild.id].clear()

        # Add to queue
        queue = self.get_queue(interaction.guild.id)
        queue.append({"type": "youtube", "url": url})
        
        # If not playing, start playing
        if not interaction.guild.voice_client.is_playing() and not self.is_fetching.get(interaction.guild.id, False):
             await self.play_next(interaction.guild, interaction.channel)
             await interaction.followup.send(f'▶️ Iniciando reproducción...')
        else:
            await interaction.followup.send(f'✅ Añadido a la cola: <{url}>')

    async def play_navidrome_items(self, interaction, songs):
        if not interaction.response.is_done():
            await interaction.response.defer()
            
        if not interaction.guild.voice_client:
            if not await self.join_voice_channel(interaction):
                return
                
        queue = self.get_queue(interaction.guild.id)
        for s in songs:
           queue.append(s)
           
        if not interaction.guild.voice_client.is_playing() and not self.is_fetching.get(interaction.guild.id, False):
            await self.play_next(interaction.guild, interaction.channel)
            await interaction.followup.send(f'▶️ Iniciando reproducción de Navidrome...')
        else:
            count_str = f"{len(songs)} canciones" if len(songs) > 1 else "1 canción"
            await interaction.followup.send(f'✅ {count_str} añadida(s) a la cola desde Navidrome.')

    async def skip(self, interaction):
        await interaction.response.defer()
        guild = interaction.guild
        if not guild.voice_client or not guild.voice_client.is_playing():
            await interaction.followup.send("No hay nada reproduciéndose.", ephemeral=True)
            return

        # Check if user is in the same voice channel
        if not interaction.user.voice or interaction.user.voice.channel != guild.voice_client.channel:
             await interaction.followup.send("Debes estar en el mismo canal de voz para saltar la canción.", ephemeral=True)
             return

        # Voting Logic
        channel_members = guild.voice_client.channel.members
        # Filter out bots
        humans = [m for m in channel_members if not m.bot]
        total_votes_needed = (len(humans) // 2) + 1
        
        # Initialize votes for this guild if needed
        if guild.id not in self.skip_votes:
            self.skip_votes[guild.id] = set()

        # Add vote
        if interaction.user.id not in self.skip_votes[guild.id]:
            self.skip_votes[guild.id].add(interaction.user.id)
            current_votes = len(self.skip_votes[guild.id])
            
            if current_votes >= total_votes_needed:
                guild.voice_client.stop()
                await interaction.followup.send("⏭️ ¡Votación completada! Saltando canción.")
                self.skip_votes[guild.id].clear()
            else:
                await interaction.followup.send(f"🗳️ Voto registrado ({current_votes}/{total_votes_needed}).")
        else:
            await interaction.followup.send("¡Ya has votado para saltar!", ephemeral=True)

    async def stop(self, interaction):
        await interaction.response.defer()
        guild_id = interaction.guild.id
        self.is_radio_mode[guild_id] = False
        if guild_id in self.radio_played_ids:
            self.radio_played_ids[guild_id].clear()
        
        if guild_id in self.queues:
            self.queues[guild_id].clear()
        if guild_id in self.skip_votes:
             self.skip_votes[guild_id].clear()
        
        if interaction.guild.voice_client:
            if interaction.guild.voice_client.is_playing():
                interaction.guild.voice_client.stop()
            await interaction.guild.voice_client.disconnect()
            await interaction.followup.send("⏹️ Música detenida y desconectada.")
        else:
             await interaction.followup.send("No estoy conectado.")

    async def queue_info(self, interaction):
        guild_id = interaction.guild.id
        queue = self.get_queue(guild_id)
        current = self.current_song.get(guild_id, "Nada")
        
        if not queue and not current:
            await interaction.response.send_message("La cola está vacía.")
            return

        embed = discord.Embed(title="🎶 Cola de Reproducción", color=discord.Color.blue())
        if current and current != "Nada":
            embed.add_field(name="Reproduciendo ahora:", value=f"**{current}**", inline=False)
        
        if queue:
            queue_text = ""
            for i, item in enumerate(queue[:10]):
                if isinstance(item, str):
                    title = item
                else:
                    title = item.get("title", item.get("url", "Unknown"))
                    if item.get("artist") and item.get("artist") not in ["Unknown Artist", "Unknown"]:
                        title = f"{item['artist']} - {title}"
                
                queue_text += f"`{i + 1}.` {title}\n"
                
            if len(queue) > 10:
                queue_text += f"\n*...y {len(queue) - 10} canciones más.*"
                
            embed.add_field(name="En cola:", value=queue_text, inline=False)
            
        view = QueueView(self, guild_id)
        await interaction.response.send_message(embed=embed, view=view)
