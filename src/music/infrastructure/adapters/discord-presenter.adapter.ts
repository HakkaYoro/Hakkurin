import { EmbedBuilder } from 'discord.js';
import type { ChannelHandle } from '../../domain/music.domain';
import type { MusicPresenter } from '../../domain/ports/music.ports';

export class DiscordPresenterAdapter implements MusicPresenter {
  async nowPlaying(channel: ChannelHandle, title: string, coverUrl: string | null): Promise<void> {
    if (!coverUrl) {
      await this.sendText(channel, `🎶 Reproduciendo ahora: **${title}**`);
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('🎶 Reproduciendo ahora')
      .setDescription(`**${title}**`)
      .setColor(0x3498db)
      .setThumbnail(coverUrl)
      .setFooter({ text: 'Hakkurei Music' });
    try {
      await channel.send({ embeds: [embed] });
    } catch {
      await this.sendText(channel, `🎶 Reproduciendo ahora: **${title}**`);
    }
  }

  async radioAdded(channel: ChannelHandle, count: number): Promise<void> {
    await this.sendText(channel, `📻 *Radio: Añadidas ${count} canciones en la cola.*`);
  }

  async playbackError(channel: ChannelHandle, message: string): Promise<void> {
    await this.sendText(channel, `Ocurrió un error al reproducir: ${message}`);
  }

  private async sendText(channel: ChannelHandle, content: string): Promise<void> {
    try {
      await channel.send(content);
    } catch {
      /* canal no disponible */
    }
  }
}
