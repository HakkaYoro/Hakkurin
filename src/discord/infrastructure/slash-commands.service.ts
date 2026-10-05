import { Injectable, Logger } from '@nestjs/common';
import type { Client } from 'discord.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import { MusicService } from '../../music/application/music.service';
import { MusicUiService } from './music-ui.service';

@Injectable()
export class SlashCommandsService {
  private readonly logger = new Logger(SlashCommandsService.name);

  constructor(
    private readonly music: MusicService,
    private readonly musicUi: MusicUiService,
  ) {}

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
      if (interaction.isMessageComponent()) return this.musicUi.handleButton(interaction as MessageComponentInteraction);
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
        return this.musicUi.handleSearch(i, i.options.getString('query', true), false);
      case 'radio':
        return this.musicUi.handleSearch(i, i.options.getString('query', true), true);
    }
  }
}
