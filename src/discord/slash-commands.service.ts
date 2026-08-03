// Registro + ruteo de slash commands (discord.js directo, sin necord) y de la vista
// de búsqueda de Navidrome (embeds + botones song_/album_/artist_ — puerto de
// navidrome_ui.py). Los resultados de búsqueda se guardan por messageId para que
// el botón resuelva el índice correcto (discord.js no acopla datos al custom_id).
import { Injectable, Logger } from '@nestjs/common';
import type { Client } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import { MusicService, type QueueItem } from '../music/music.service';
import { NavidromeService } from '../navidrome/navidrome.service';

interface SearchSnapshot {
  songs: any[];
  albums: any[];
  artists: any[];
  isRadio: boolean;
}

@Injectable()
export class SlashCommandsService {
  private readonly logger = new Logger(SlashCommandsService.name);
  private readonly snapshots = new Map<string, SearchSnapshot>();

  constructor(
    private readonly music: MusicService,
    private readonly navidrome: NavidromeService,
  ) {}

  /** Registra los 6 comandos globalmente (onReady). */
  async register(client: Client): Promise<void> {
    const commands = [
      new SlashCommandBuilder().setName('play').setDescription('Reproduce música desde una URL de YouTube')
        .addStringOption((o) => o.setName('url').setDescription('La URL del video o canción').setRequired(true)),
      new SlashCommandBuilder().setName('skip').setDescription('Vota para saltar la canción actual'),
      new SlashCommandBuilder().setName('stop').setDescription('Detiene la música y desconecta al bot'),
      new SlashCommandBuilder().setName('queue').setDescription('Muestra la cola de reproducción actual'),
      new SlashCommandBuilder().setName('search').setDescription('Busca en Navidrome')
        .addStringOption((o) => o.setName('query').setDescription('Lo que deseas buscar').setRequired(true)),
      new SlashCommandBuilder().setName('radio').setDescription('Inicia una radio desde Navidrome')
        .addStringOption((o) => o.setName('query').setDescription('Lo que deseas buscar para iniciar la radio').setRequired(true)),
    ].map((c) => c.toJSON());
    try {
      await client.application?.commands.set(commands);
      this.logger.log('Slash commands registrados.');
    } catch (e) {
      this.logger.error(`Error registrando slash commands: ${(e as Error).message}`);
    }
  }

  async handle(interaction: ChatInputCommandInteraction | MessageComponentInteraction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) return this.handleCommand(interaction);
      if (interaction.isMessageComponent()) return this.handleButton(interaction as MessageComponentInteraction);
    } catch (e) {
      this.logger.error(`Error en interacción: ${(e as Error).message}`);
    }
  }

  private async handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    switch (i.commandName) {
      case 'play':
        return this.music.play(i, i.options.getString('url', true));
      case 'skip':
        return this.music.skip(i);
      case 'stop':
        return this.music.stop(i);
      case 'queue':
        return this.music.queueInfo(i);
      case 'search':
        return this.handleSearch(i, i.options.getString('query', true), false);
      case 'radio':
        return this.handleSearch(i, i.options.getString('query', true), true);
    }
  }

  // --- Vista de búsqueda Navidrome (navidrome_ui.py) ---
  private async handleSearch(i: ChatInputCommandInteraction, query: string, isRadio: boolean): Promise<void> {
    await i.deferReply().catch(() => {});
    const results = await this.navidrome.search(query, 5);
    const songs = toArray(results.song).slice(0, 5);
    const albums = toArray(results.album).slice(0, 5);
    const artists = toArray(results.artist).slice(0, 5);

    const content = this.buildSearchText(query, songs, albums, artists, isRadio);
    if (!songs.length && !albums.length && !artists.length) {
      await i.editReply(content).catch(() => {});
      return;
    }
    const components = this.buildRows(songs, albums, artists);
    const msg = await i.editReply({ content, components }).catch(() => null);
    if (msg) {
      this.snapshots.set(msg.id, { songs, albums, artists, isRadio });
      // Expira a los 120s como el timeout del View de Python (navidrome_ui.py:6).
      setTimeout(() => this.snapshots.delete(msg.id), 120_000);
    }
  }

  private buildSearchText(query: string, songs: any[], albums: any[], artists: any[], isRadio: boolean): string {
    const title = isRadio ? `📻 Resultados para Radio: ${query}` : `🔍 Resultados de Navidrome para: ${query}`;
    const lines: string[] = [title];
    if (songs.length) lines.push('**🎵 Canciones**', ...songs.map((s, idx) => `\`${idx + 1}.\` ${s.title ?? ''} - ${s.artist ?? ''}`));
    if (albums.length) lines.push('**💿 Álbumes**', ...albums.map((a, idx) => `\`${idx + 1}.\` ${a.name ?? ''} - ${a.artist ?? ''}`));
    if (artists.length) lines.push('**👤 Artistas**', ...artists.map((a, idx) => `\`${idx + 1}.\` ${a.name ?? ''}`));
    if (!songs.length && !albums.length && !artists.length) lines.push('No se encontraron resultados.');
    return lines.join('\n');
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

  private async handleButton(i: MessageComponentInteraction): Promise<void> {
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

function toArray(x: any): any[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}
