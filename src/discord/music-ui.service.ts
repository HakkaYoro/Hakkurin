// Vista de búsqueda de Navidrome (embeds + botones song_/album_/artist_ — puerto de
// navidrome_ui.py), extraída de SlashCommandsService. Los resultados se guardan por
// messageId para que el botón resuelva el índice correcto (discord.js no acopla
// datos al custom_id).
import { Injectable } from '@nestjs/common';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import { MusicService, type QueueItem } from '../music/music.service';
import { NavidromeService } from '../navidrome/navidrome.service';
import { toArray } from '../common/util';

interface SearchSnapshot {
  songs: any[];
  albums: any[];
  artists: any[];
  isRadio: boolean;
}

@Injectable()
export class MusicUiService {
  private readonly snapshots = new Map<string, SearchSnapshot>();

  constructor(
    private readonly music: MusicService,
    private readonly navidrome: NavidromeService,
  ) {}

  async handleSearch(i: ChatInputCommandInteraction, query: string, isRadio: boolean): Promise<void> {
    await i.deferReply().catch(() => {});
    const results = await this.navidrome.search(query, 5);
    const songs = toArray(results.song).slice(0, 5);
    const albums = toArray(results.album).slice(0, 5);
    const artists = toArray(results.artist).slice(0, 5);

    const embed = this.buildSearchEmbed(query, songs, albums, artists, isRadio);
    if (!songs.length && !albums.length && !artists.length) {
      // Sin resultados: mismo embed, sin botones.
      await i.editReply({ embeds: [embed] }).catch(() => {});
      return;
    }
    const components = this.buildRows(songs, albums, artists);
    const msg = await i.editReply({ embeds: [embed], components }).catch(() => null);
    if (msg) {
      this.snapshots.set(msg.id, { songs, albums, artists, isRadio });
      // Expira a los 120s como el timeout del View de Python (navidrome_ui.py:6).
      setTimeout(() => this.snapshots.delete(msg.id), 120_000);
    }
  }

  // ponytail: `any` — el search3 de Subsonic llega suelto del XML; tiparlo es trabajo
  // de NavidromeService, no de la vista.
  private buildSearchEmbed(
    query: string,
    songs: any[],
    albums: any[],
    artists: any[],
    isRadio: boolean,
  ): EmbedBuilder {
    const title = isRadio ? `📻 Radio: ${query}` : `🔍 Resultados de Navidrome: ${query}`;
    const lines: string[] = [];
    if (songs.length)
      lines.push('**🎵 Canciones**', ...songs.map((s, idx) => `\`${idx + 1}.\` ${s.title ?? ''} - ${s.artist ?? ''}`));
    if (albums.length)
      lines.push('**💿 Álbumes**', ...albums.map((a, idx) => `\`${idx + 1}.\` ${a.name ?? ''} - ${a.artist ?? ''}`));
    if (artists.length) lines.push('**👤 Artistas**', ...artists.map((a, idx) => `\`${idx + 1}.\` ${a.name ?? ''}`));

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0x3498db)
      .setFooter({ text: 'Hakkurei Music' })
      .setDescription(lines.length ? lines.join('\n') : 'No se encontraron resultados.');
    // Thumbnail estilo "Reproduciendo ahora": cover de la 1ª canción, si no del 1º álbum.
    const thumb = this.navidrome.getCoverUrl(songs[0]?.coverArt) ?? this.navidrome.getCoverUrl(albums[0]?.coverArt);
    if (thumb) embed.setThumbnail(thumb);
    return embed;
  }

  private buildRows(songs: any[], albums: any[], artists: any[]): ActionRowBuilder<ButtonBuilder>[] {
    const mk = (prefix: string, items: any[], emoji: string) => {
      const row = new ActionRowBuilder<ButtonBuilder>();
      items.forEach((_, idx) =>
        row.addComponents(
          new ButtonBuilder().setCustomId(`${prefix}_${idx}`).setLabel(String(idx + 1)).setEmoji(emoji).setStyle(ButtonStyle.Primary),
        ),
      );
      return row;
    };
    return [mk('song', songs, '🎵'), mk('album', albums, '💿'), mk('artist', artists, '👤')].filter((r) => r.components.length);
  }

  async handleButton(i: MessageComponentInteraction): Promise<void> {
    const snap = this.snapshots.get(i.message.id);
    if (!snap) {
      await i.reply({ content: 'Esta búsqueda ya expiró. Usa /search o /radio de nuevo.', ephemeral: true }).catch(() => {});
      return;
    }
    const [kind, idxStr] = i.customId.split('_');
    const idx = Number(idxStr);
    await i.deferUpdate().catch(() => {});
    const guildId = i.guildId!;

    let items: QueueItem[] = [];
    if (kind === 'song') {
      const song = snap.songs[idx];
      if (song) items = [this.music.songToItem(song)];
    } else if (kind === 'album') {
      const album = snap.albums[idx];
      if (album) items = (await this.navidrome.getAlbumSongs(album.id)).map((s) => this.music.songToItem(s));
    } else if (kind === 'artist') {
      const artist = snap.artists[idx];
      if (artist) items = (await this.navidrome.getArtistRadio(artist.name, 20)).map((s) => this.music.songToItem(s));
    }

    if (snap.isRadio && items.length) this.music.startRadioMode(guildId);

    // El botón es un MessageComponentInteraction (no ChatInputCommandInteraction),
    // así que unimos por guild/member y encolamos por canal directo.
    if (!items.length) {
      await i.editReply({ content: 'No se encontraron canciones para esa selección.', components: [] }).catch(() => {});
      return;
    }
    const guild = (i as any).guild;
    const member = i.member as any;
    const channel = i.channel as any;
    if (!guild || !member || !channel) {
      await i.editReply({ content: 'No pude determinar el canal/guild para reproducir.', components: [] }).catch(() => {});
      return;
    }
    const joined = await this.music.joinFromButton(guild, member);
    if (!joined) {
      await i.editReply({ content: '¡Necesitas estar en un canal de voz!', components: [] }).catch(() => {});
      return;
    }
    await this.music.enqueueAndPlay(guild, channel, items);
    await i.editReply({ content: `✅ ${items.length} añadida(s) a la cola.`, components: [] }).catch(() => {});
  }
}
