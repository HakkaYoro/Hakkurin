// Adaptador MusicPresenter: mensajes de playback al canal de texto vía Discord
// (embed de now playing, aviso de radio, error de reproducción).
import { EmbedBuilder, type TextChannel } from 'discord.js';
import type { MusicPresenter } from './music.ports';

export class DiscordPresenter implements MusicPresenter {
  async nowPlaying(channel: TextChannel, title: string, coverUrl: string | null): Promise<void> {
    if (!coverUrl) {
      await sendText(channel, `🎶 Reproduciendo ahora: **${title}**`);
      return;
    }
    await this.sendNowPlayingEmbed(channel, title, coverUrl);
  }

  async radioAdded(channel: TextChannel, count: number): Promise<void> {
    await sendText(channel, `📻 *Radio: Añadidas ${count} canciones en la cola.*`);
  }

  async playbackError(channel: TextChannel, message: string): Promise<void> {
    await sendText(channel, `Ocurrió un error al reproducir: ${message}`);
  }

  private async sendNowPlayingEmbed(channel: TextChannel, title: string, coverUrl: string): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🎶 Reproduciendo ahora')
      .setDescription(`**${title}**`)
      .setColor(0x3498db) // blue
      .setThumbnail(coverUrl)
      .setFooter({ text: 'Hakkurei Music' });

    try {
      await channel.send({ embeds: [embed] });
    } catch {
      await sendText(channel, `🎶 Reproduciendo ahora: **${title}**`);
    }
  }
}

async function sendText(channel: TextChannel | null, content: string): Promise<void> {
  if (!channel) return;
  try {
    await (channel as any).send(content);
  } catch {
    /* canal no disponible */
  }
}
