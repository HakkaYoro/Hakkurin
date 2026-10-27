// Comandos for-fun (anime/otaku): Jikan para fichas, nekos.best para gifs e
// imágenes (gratis, sin key). Embeds al estilo de music-ui: título con emoji,
// color por familia, footer del bot, thumbnail/imagen cuando aporta.
import { Injectable, Logger } from '@nestjs/common';
import { EmbedBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { ConfigService } from '../../common/config.service';
import {
  ACCIONES,
  nekosCredit,
  nekosPick,
  shipPercent,
  shipTags,
  uwuify,
  WAIFU_CATEGORIES,
  type NekosHit,
} from '../domain/fun.domain';

const UA = 'Hakkurin/1.0 (Discord bot)';
const logger = new Logger('fun');

// Paleta otaku: info=violeta, waifu/acción=rosa, ship=fucsia.
const COLOR_INFO = 0x9b59b6;
const COLOR_WAIFU = 0xff69b4;
const COLOR_SHIP = 0xe91e63;

//ponytail: fetch sin cache ni retry; Jikan rate-limit 60/min sobra para un bot casero. Upgrade: cache TTL si esto crece.
async function jikanGet(path: string): Promise<any | null> {
  try {
    const res = await fetch(`https://api.jikan.moe/v4${path}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn(`jikan ${path.split('?')[0]}: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    logger.warn(`jikan ${path.split('?')[0]}: ${(e as Error).message}`);
    return null;
  }
}

async function nekosGet(cat: string): Promise<NekosHit | null> {
  try {
    const res = await fetch(`https://nekos.best/api/v2/${cat}?amount=8`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn(`nekos "${cat}": HTTP ${res.status}`);
      return null;
    }
    const hit = nekosPick(await res.json());
    if (!hit) logger.warn(`nekos "${cat}": respuesta sin resultados`);
    return hit;
  } catch (e) {
    logger.warn(`nekos "${cat}": ${(e as Error).message}`);
    return null;
  }
}

@Injectable()
export class FunService {
  constructor(private readonly config: ConfigService) {}

  private footer(e: EmbedBuilder): EmbedBuilder {
    return e.setFooter({ text: `${this.config.get('bot_name', 'Hakkurin')} ♡` }).setTimestamp();
  }

  private errorEmbed(msg: string): EmbedBuilder {
    return this.footer(new EmbedBuilder().setTitle('😖').setDescription(msg).setColor(COLOR_INFO));
  }

  async handleAnime(i: ChatInputCommandInteraction, query: string): Promise<void> {
    await i.deferReply().catch(() => {});
    const json = await jikanGet(`/anime?q=${encodeURIComponent(query)}&limit=1&sfw=true`);
    const a = json?.data?.[0];
    if (!a) {
      await i.editReply({ embeds: [this.errorEmbed(`No encontré "${query}"... ¿lo soñaste, baka?`)] }).catch(() => {});
      return;
    }
    const e = this.footer(
      new EmbedBuilder()
        .setTitle(`📺 ${a.title}`)
        .setURL(a.url ?? null)
        .setColor(COLOR_INFO)
        .setDescription((a.synopsis || 'Sin sinopsis.').slice(0, 400)),
    );
    e.addFields(
      { name: '⭐ Score', value: a.score ? String(a.score) : '—', inline: true },
      { name: '📅 Año', value: a.year ? String(a.year) : '—', inline: true },
      { name: '🎬 Episodios', value: a.episodes ? String(a.episodes) : '—', inline: true },
      { name: '📡 Estado', value: a.status ?? '—', inline: true },
    );
    const img = a.images?.jpg?.large_image_url || a.images?.jpg?.image_url;
    if (img) e.setImage(img);
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleManga(i: ChatInputCommandInteraction, query: string): Promise<void> {
    await i.deferReply().catch(() => {});
    const json = await jikanGet(`/manga?q=${encodeURIComponent(query)}&limit=1&sfw=true`);
    const m = json?.data?.[0];
    if (!m) {
      await i.editReply({ embeds: [this.errorEmbed(`No encontré "${query}" en los mangas...`)] }).catch(() => {});
      return;
    }
    const e = this.footer(
      new EmbedBuilder()
        .setTitle(`📚 ${m.title}`)
        .setURL(m.url ?? null)
        .setColor(COLOR_INFO)
        .setDescription((m.synopsis || 'Sin sinopsis.').slice(0, 400)),
    );
    const autores = (m.authors ?? []).map((x: any) => x.name).join(', ');
    e.addFields(
      { name: '⭐ Score', value: m.score ? String(m.score) : '—', inline: true },
      { name: '📚 Tomos', value: m.volumes ? String(m.volumes) : '—', inline: true },
      { name: '📄 Capítulos', value: m.chapters ? String(m.chapters) : '—', inline: true },
      { name: '✍️ Autor', value: autores || '—', inline: false },
    );
    const img = m.images?.jpg?.large_image_url || m.images?.jpg?.image_url;
    if (img) e.setImage(img);
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleTemporada(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply().catch(() => {});
    const json = await jikanGet('/seasons/now?sfw=true&limit=10');
    const animes: any[] = json?.data ?? [];
    if (!animes.length) {
      await i.editReply({ embeds: [this.errorEmbed('Jikan no respondió, inténtalo luego.')] }).catch(() => {});
      return;
    }
    const lines = animes
      .map((a, idx) => `\`${idx + 1}.\` ${a.url ? `[${a.title}](${a.url})` : a.title} — ⭐ ${a.score ?? '—'}`)
      .join('\n');
    const primero = animes[0];
    const title = `🌸 Temporada ${primero.season ?? ''} ${primero.year ?? ''}`.replace(/\s+/g, ' ').trim();
    const e = this.footer(new EmbedBuilder().setTitle(title).setColor(COLOR_INFO).setDescription(lines));
    const img = primero.images?.jpg?.large_image_url || primero.images?.jpg?.image_url;
    if (img) e.setThumbnail(img);
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleWaifu(i: ChatInputCommandInteraction, category: string): Promise<void> {
    await i.deferReply().catch(() => {});
    if (!(WAIFU_CATEGORIES as readonly string[]).includes(category)) {
      await i.editReply({ embeds: [this.errorEmbed('Esa categoría no existe, baka.')] }).catch(() => {});
      return;
    }
    const hit = await nekosGet(category);
    if (!hit) {
      await i.editReply({ embeds: [this.errorEmbed('nekos.best no respondió, inténtalo luego... quédate con tu imaginación por hoy.')] }).catch(() => {});
      return;
    }
    const e = this.footer(
      new EmbedBuilder()
        .setTitle('💌 Tu dosis diaria de 2D')
        .setColor(COLOR_WAIFU)
        .setDescription(nekosCredit(hit).trim())
        .setImage(hit.url),
    );
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleAccion(i: ChatInputCommandInteraction, tipo: string, targetId: string | null): Promise<void> {
    await i.deferReply().catch(() => {});
    const accion = ACCIONES[tipo];
    if (!accion) {
      await i.editReply({ embeds: [this.errorEmbed('No conozco esa acción, baka.')] }).catch(() => {});
      return;
    }
    const hit = await nekosGet(accion.cat);
    const autor = i.user.displayName ?? i.user.username;
    const objetivo = targetId ? `<@${targetId}>` : null;
    const frase = objetivo ? `**${autor}** ${accion.con} ${objetivo}` : `**${autor}** ${accion.solo}`;
    const e = this.footer(new EmbedBuilder().setDescription(frase + (hit ? nekosCredit(hit) : '')).setColor(COLOR_WAIFU));
    if (hit) e.setImage(hit.url);
    if (targetId) e.setThumbnail(i.user.displayAvatarURL());
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleShip(i: ChatInputCommandInteraction, u1: User, u2: User): Promise<void> {
    await i.deferReply().catch(() => {});
    const auto = u1.id === u2.id;
    const pct = auto ? 100 : shipPercent(u1.id, u2.id);
    const { cat, veredicto } = shipTags(pct);
    const hit = await nekosGet(cat);
    const hearts = Math.round(pct / 10);
    const bar = '❤️'.repeat(hearts) + '🖤'.repeat(10 - hearts);
    const nombre = (u: User) => u.displayName ?? u.username;
    const e = this.footer(
      new EmbedBuilder()
        .setTitle(`${nombre(u1)} 💕 ${nombre(u2)}`)
        .setColor(COLOR_SHIP)
        .setDescription(`${bar}\n**${pct}%** — ${veredicto}${hit ? nekosCredit(hit) : ''}`),
    );
    e.setThumbnail(u1.displayAvatarURL());
    if (hit) e.setImage(hit.url);
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleUwu(i: ChatInputCommandInteraction, text: string): Promise<void> {
    const trimmed = text.trim().slice(0, 1900);
    if (!trimmed) {
      await i.reply({ content: 'eso no se puede uwu-ificar, baka', ephemeral: true }).catch(() => {});
      return;
    }
    await i.reply({ content: uwuify(trimmed) }).catch(() => {});
  }
}
