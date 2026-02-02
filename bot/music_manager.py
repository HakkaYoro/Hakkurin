import discord
import asyncio
import yt_dlp
import logging
import functools

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

class MusicManager:
    def __init__(self, bot):
        self.bot = bot
        self.logger = logging.getLogger("MusicManager")
        self.queues = {} # guild_id -> list of urls/titles
        self.current_song = {} # guild_id -> current song title
        self.skip_votes = {} # guild_id -> set(user_id)

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
            return True
        else:
            await interaction.response.send_message("¡Necesitas estar en un canal de voz para que pueda poner música!", ephemeral=True)
            return False

    async def play_next(self, guild, channel):
        guild_id = guild.id
        queue = self.get_queue(guild_id)
        
        # Clear skip votes when song changes
        if guild_id in self.skip_votes:
            self.skip_votes[guild_id].clear()

        if len(queue) >= 1:
            url = queue.pop(0)
            # async with channel.typing(): # Typing might fail if interaction context is lost/different
            try:
                player = await YTDLSource.from_url(url, loop=self.bot.loop, stream=True)
                if guild.voice_client:
                    guild.voice_client.play(player, after=lambda e: self.bot.loop.create_task(self.play_next(guild, channel)))
                    self.current_song[guild_id] = player.title
                    await channel.send(f'🎶 Reproduciendo ahora: **{player.title}**')
                else:
                     self.logger.warning("Voice client disappeared during play_next")

            except Exception as e:
                self.logger.error(f"Error reproduciendo música: {e}")
                await channel.send(f"Ocurrió un error al intentar reproducir la canción: {str(e)}")
                # Try next one
                await self.play_next(guild, channel)
        else:
            self.current_song[guild_id] = None

    async def play(self, interaction, url):
        # Join channel if not already in one
        if not interaction.guild.voice_client:
            if not await self.join_voice_channel(interaction):
                return
        
        # Defer response as extracting info takes time
        await interaction.response.defer()

        # Add to queue
        queue = self.get_queue(interaction.guild.id)
        queue.append(url)
        
        # If not playing, start playing
        if not interaction.guild.voice_client.is_playing():
             await self.play_next(interaction.guild, interaction.channel)
             await interaction.followup.send(f'▶️ Iniciando reproducción...')
        else:
            await interaction.followup.send(f'✅ Añadido a la cola: <{url}>')

    async def skip(self, interaction):
        guild = interaction.guild
        if not guild.voice_client or not guild.voice_client.is_playing():
            await interaction.response.send_message("No hay nada reproduciéndose.", ephemeral=True)
            return

        # Check if user is in the same voice channel
        if not interaction.user.voice or interaction.user.voice.channel != guild.voice_client.channel:
             await interaction.response.send_message("Debes estar en el mismo canal de voz para saltar la canción.", ephemeral=True)
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
                await interaction.response.send_message("⏭️ ¡Votación completada! Saltando canción.")
                self.skip_votes[guild.id].clear()
            else:
                await interaction.response.send_message(f"🗳️ Voto registrado ({current_votes}/{total_votes_needed}).")
        else:
            await interaction.response.send_message("¡Ya has votado para saltar!", ephemeral=True)

    async def stop(self, interaction):
        await interaction.response.defer()
        guild_id = interaction.guild.id
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

        msg = f"🎶 **Reproduciendo ahora:** {current}\n\n**En cola:**\n"
        for i, url in enumerate(queue):
            msg += f"{i+1}. {url}\n"
            if i >= 9:
                msg += "... y más"
                break
        await interaction.response.send_message(msg)
