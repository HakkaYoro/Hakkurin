import { Injectable, Logger } from '@nestjs/common';
import type { Client } from 'discord.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import { MusicService } from '../../music/application/music.service';
import { MusicUiService } from './music-ui.service';
import { FunService } from './fun.service';
import { StatsService } from '../../stats/stats.service';

@Injectable()
export class SlashCommandsService {
  private readonly logger = new Logger(SlashCommandsService.name);

  constructor(
    private readonly music: MusicService,
    private readonly musicUi: MusicUiService,
    private readonly fun: FunService,
    private readonly stats: StatsService,
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
      new SlashCommandBuilder().setName('anime').setDescription('Busca un anime en MyAnimeList')
        .addStringOption((o) => o.setName('nombre').setDescription('Título del anime').setRequired(true)),
      new SlashCommandBuilder().setName('manga').setDescription('Busca un manga en MyAnimeList')
        .addStringOption((o) => o.setName('nombre').setDescription('Título del manga').setRequired(true)),
      new SlashCommandBuilder().setName('temporada').setDescription('Los animes al aire esta temporada'),
      new SlashCommandBuilder().setName('waifu').setDescription('Tu dosis diaria de 2D')
        .addStringOption((o) => o.setName('categoria').setDescription('Qué quieres ver').addChoices(
          { name: 'waifu', value: 'waifu' },
          { name: 'husbando', value: 'husbando' },
          { name: 'neko', value: 'neko' },
          { name: 'kitsune', value: 'kitsune' },
        )),
      new SlashCommandBuilder().setName('accion').setDescription('Acción con gif de anime hacia alguien (o al aire)')
        .addStringOption((o) => o.setName('tipo').setDescription('Qué hacer').setRequired(true).addChoices(
          { name: 'abrazar', value: 'abrazar' },
          { name: 'acariciar', value: 'acariciar' },
          { name: 'bofetada', value: 'bofetada' },
          { name: 'besar', value: 'besar' },
          { name: 'morder', value: 'morder' },
          { name: 'bonk', value: 'bonk' },
          { name: 'achuchar', value: 'achuchar' },
        ))
        .addUserOption((o) => o.setName('usuario').setDescription('Objetivo de la acción (opcional)')),
      new SlashCommandBuilder().setName('ship').setDescription('Compatibilidad entre dos usuarios')
        .addUserOption((o) => o.setName('primero').setDescription('Primer usuario').setRequired(true))
        .addUserOption((o) => o.setName('segundo').setDescription('Segundo usuario').setRequired(true)),
      new SlashCommandBuilder().setName('uwu').setDescription('Convierte tu texto a uwu-speak')
        .addStringOption((o) => o.setName('texto').setDescription('Lo que quieres uwu-ificar').setRequired(true)),
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
    this.stats.bumpCommand(i.commandName, i.user.id);
    this.logger.log(`/${i.commandName} — ${i.user.username}`);
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
      case 'anime':
        return this.fun.handleAnime(i, i.options.getString('nombre', true));
      case 'manga':
        return this.fun.handleManga(i, i.options.getString('nombre', true));
      case 'temporada':
        return this.fun.handleTemporada(i);
      case 'waifu':
        return this.fun.handleWaifu(i, i.options.getString('categoria') ?? 'waifu');
      case 'accion':
        return this.fun.handleAccion(i, i.options.getString('tipo', true), i.options.getUser('usuario')?.id ?? null);
      case 'ship':
        return this.fun.handleShip(i, i.options.getUser('primero', true), i.options.getUser('segundo', true));
      case 'uwu':
        return this.fun.handleUwu(i, i.options.getString('texto', true));
    }
  }
}
