import discord
from bot.navidrome_client import navidrome_client

class NavidromeSearchView(discord.ui.View):
    def __init__(self, music_manager, search_results, original_interaction, is_radio=False):
        super().__init__(timeout=120)  # 2 minutes timeout
        self.music_manager = music_manager
        self.search_results = search_results
        self.original_interaction = original_interaction
        self.is_radio = is_radio
        
        self.songs = search_results.get('song', [])[:5]
        self.albums = search_results.get('album', [])[:5]
        self.artists = search_results.get('artist', [])[:5]

        # Add buttons dynamically
        for idx in range(len(self.songs)):
            btn = discord.ui.Button(label=str(idx+1), emoji="🎵", custom_id=f"song_{idx}", row=0)
            btn.callback = self.song_callback
            self.add_item(btn)

        for idx in range(len(self.albums)):
            btn = discord.ui.Button(label=str(idx+1), emoji="💿", custom_id=f"album_{idx}", row=1)
            btn.callback = self.album_callback
            self.add_item(btn)
            
        for idx in range(len(self.artists)):
            btn = discord.ui.Button(label=str(idx+1), emoji="👤", custom_id=f"artist_{idx}", row=2)
            btn.callback = self.artist_callback
            self.add_item(btn)

    def _create_song_item(self, song):
        return {
            "type": "navidrome",
            "url": navidrome_client.get_stream_url(song["id"]),
            "id": song["id"],
            "title": song.get("title", "Unknown"),
            "artist": song.get("artist", "Unknown"),
            "album": song.get("album", "Unknown Album"),
            "cover_url": navidrome_client.get_cover_url(song.get("coverArt"))
        }

    async def _play_radio_for_artist(self, interaction, artist_name):
        artist_songs = await navidrome_client.get_artist_radio(artist_name, count=20)
        items = [self._create_song_item(s) for s in artist_songs]
        if items:
            await self.music_manager.play_navidrome_items(interaction, items)
        else:
            await interaction.followup.send(f"No se encontraron canciones para el artista: {artist_name}", ephemeral=True)

    async def song_callback(self, interaction: discord.Interaction):
        await interaction.response.defer()
        idx = int(interaction.data["custom_id"].split("_")[1])
        song = self.songs[idx]
        item = self._create_song_item(song)
        if self.is_radio:
            self.music_manager.is_radio_mode[interaction.guild.id] = True
            self.music_manager.radio_played_ids[interaction.guild.id] = set()
        await self.music_manager.play_navidrome_items(interaction, [item])
        await self._disable_all()

    async def album_callback(self, interaction: discord.Interaction):
        await interaction.response.defer()
        idx = int(interaction.data["custom_id"].split("_")[1])
        album = self.albums[idx]
        album_songs = await navidrome_client.get_album_songs(album["id"])
        items = [self._create_song_item(s) for s in album_songs]
        if self.is_radio:
            self.music_manager.is_radio_mode[interaction.guild.id] = True
            self.music_manager.radio_played_ids[interaction.guild.id] = set()
        if items:
            await self.music_manager.play_navidrome_items(interaction, items)
        else:
            await interaction.followup.send("No se encontraron canciones en este álbum.", ephemeral=True)
        await self._disable_all()

    async def artist_callback(self, interaction: discord.Interaction):
        await interaction.response.defer()
        idx = int(interaction.data["custom_id"].split("_")[1])
        artist = self.artists[idx]
        if self.is_radio:
            self.music_manager.is_radio_mode[interaction.guild.id] = True
            self.music_manager.radio_played_ids[interaction.guild.id] = set()
        await self._play_radio_for_artist(interaction, artist["name"])
        await self._disable_all()

    async def _disable_all(self):
        for item in self.children:
            item.disabled = True
        try:
            msg = await self.original_interaction.original_response()
            await msg.edit(view=self)
        except:
            pass
        self.stop()

    def generate_embed(self, query):
        embed = discord.Embed(title=f"🔍 Resultados de Navidrome para: {query}", color=discord.Color.green())
        
        if self.songs:
            song_lines = []
            for i, s in enumerate(self.songs):
                song_lines.append(f"`{i+1}.` {s.get('title')} - {s.get('artist')}")
            embed.add_field(name="🎵 Canciones", value="\n".join(song_lines), inline=False)
            
        if self.albums:
            album_lines = []
            for i, a in enumerate(self.albums):
                album_lines.append(f"`{i+1}.` {a.get('name')} - {a.get('artist')}")
            embed.add_field(name="💿 Álbumes", value="\n".join(album_lines), inline=False)
            
        if self.artists:
            artist_lines = []
            for i, a in enumerate(self.artists):
                artist_lines.append(f"`{i+1}.` {a.get('name')}")
            embed.add_field(name="👤 Artistas", value="\n".join(artist_lines), inline=False)

        if not self.songs and not self.albums and not self.artists:
            embed.description = "No se encontraron resultados."
            
        return embed
