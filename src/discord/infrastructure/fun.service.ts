// Comandos for-fun (anime/otaku). Embeds al estilo de music-ui: título con
// emoji, color por familia, footer del bot, thumbnail/imagen cuando aporta.
import { Injectable } from '@nestjs/common';
import { EmbedBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { ConfigService } from '../../common/config.service';

const UA = 'Hakkurin/1.0 (Discord bot)';

// Paleta otaku: info=violeta, waifu/acción=rosa, ship=fucsia.
const COLOR_INFO = 0x9b59b6;
const COLOR_WAIFU = 0xff69b4;
const COLOR_SHIP = 0xe91e63;

// Determinista: el mismo par SIEMPRE da el mismo % (el destino no cambia).
export function shipPercent(a: string, b: string): number {
  const [x, y] = [a, b].sort();
  let h = 5381;
  for (const c of `${x}:${y}`) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h % 101;
}

export interface ShipTier {
  min: number;
  tags: string;
  veredicto: string;
}

export const SHIP_TIERS: ShipTier[] = [
  { min: 0, tags: 'anime angry slap', veredicto: 'ni con portales de another world... 💔' },
  { min: 20, tags: 'anime annoyed hmph', veredicto: 'meh, como agua para perros 🙄' },
  { min: 40, tags: 'anime confused sweat drop', veredicto: 'ni fu ni fa, pura neutralidad 😐' },
  { min: 60, tags: 'anime couple blushing', veredicto: 'se nota la química, eh 💕' },
  { min: 80, tags: 'anime wedding kiss', veredicto: '¡boda en el santuario YA! 💍✨' },
];

export function shipTags(pct: number): ShipTier {
  let tier = SHIP_TIERS[0];
  for (const t of SHIP_TIERS) if (pct >= t.min) tier = t;
  return tier;
}

export function uwuify(text: string): string {
  return `${text.replace(/[lr]/gi, (c) => (c === c.toUpperCase() ? 'W' : 'w')).trim()} uwu`;
}

//ponytail: fetch sin cache ni retry; Jikan rate-limit 60/min sobra para un bot casero. Upgrade: cache TTL si esto crece.
async function jikanGet(path: string): Promise<any | null> {
  try {
    const res = await fetch(`https://api.jikan.moe/v4${path}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waifuPics(category: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.waifu.pics/sfw/${category}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json?.url ?? null;
  } catch {
    return null;
  }
}

async function tenorGif(tags: string, apiKey: string): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const q = new URLSearchParams({ q: tags, key: apiKey, limit: '8', random: 'true', media_filter: 'gif' });
    const res = await fetch(`https://tenor.googleapis.com/v2/search?${q}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return json?.results?.[0]?.media_formats?.gif?.url ?? null;
  } catch {
    return null;
  }
}

interface Accion {
  ep: string; // endpoint waifu.pics
  con: string; // frase con objetivo
  solo: string; // frase sin objetivo
}

const ACCIONES: Record<string, Accion> = {
  abrazar: { ep: 'hug', con: 'abraza a', solo: 'reparto abrazos gratis, ¿alguien? 🤗' },
  acariciar: { ep: 'pat', con: 'acaricia la cabeza de', solo: 'doy caricias en la cabeza 💗' },
  bofetada: { ep: 'slap', con: 'bofetea a', solo: 'tengo la mano inquieta... quien caiga, cae 👋' },
  besar: { ep: 'kiss', con: 'besa a', solo: 'busco a quien besar, hagan fila 😳' },
  morder: { ep: 'bite', con: 'muerde a', solo: 'ando mordelona hoy, cuidado 🦷' },
  bonk: { ep: 'bonk', con: 'bonkea a', solo: 'bonk disponible para mentes sucias 🔨' },
  achuchar: { ep: 'cuddle', con: 'se achucha con', solo: 'necesito achuchones urgentes 🥺' },
};

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
    const url = await waifuPics(category);
    if (!url) {
      await i.editReply({ embeds: [this.errorEmbed('waifu.pics no respondió... quédate con tu imaginación por hoy.')] }).catch(() => {});
      return;
    }
    const e = this.footer(
      new EmbedBuilder().setTitle('💌 Tu dosis diaria de 2D').setColor(COLOR_WAIFU).setImage(url),
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
    const gif = await waifuPics(accion.ep);
    const autor = i.user.displayName ?? i.user.username;
    const objetivo = targetId ? `<@${targetId}>` : null;
    const frase = objetivo ? `**${autor}** ${accion.con} ${objetivo}` : `**${autor}** ${accion.solo}`;
    const e = this.footer(new EmbedBuilder().setDescription(frase).setColor(COLOR_WAIFU));
    if (gif) e.setImage(gif);
    if (targetId) e.setThumbnail(i.user.displayAvatarURL());
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleShip(i: ChatInputCommandInteraction, u1: User, u2: User): Promise<void> {
    await i.deferReply().catch(() => {});
    const auto = u1.id === u2.id;
    const pct = auto ? 100 : shipPercent(u1.id, u2.id);
    const { tags, veredicto } = shipTags(pct);
    const gif = await tenorGif(tags, this.config.get<string>('tenor_api_key', ''));
    const hearts = Math.round(pct / 10);
    const bar = '❤️'.repeat(hearts) + '🖤'.repeat(10 - hearts);
    const nombre = (u: User) => u.displayName ?? u.username;
    const titulo = `${nombre(u1)} 💕 ${nombre(u2)}`;
    const e = this.footer(
      new EmbedBuilder()
        .setTitle(titulo)
        .setColor(COLOR_SHIP)
        .setDescription(`${bar}\n**${pct}%** — ${veredicto}`),
    );
    e.setThumbnail(u1.displayAvatarURL());
    if (gif) e.setImage(gif);
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
