// Comandos for-fun (anime/otaku). Embeds al estilo de music-ui: título con
// emoji, color por familia, footer del bot, thumbnail/imagen cuando aporta.
import { Injectable, Logger } from '@nestjs/common';
import { EmbedBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { ConfigService } from '../../common/config.service';

const UA = 'Hakkurin/1.0 (Discord bot)';
const logger = new Logger('fun');

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
  q: string; // query de búsqueda en KLIPY
  veredicto: string;
}

export const SHIP_TIERS: ShipTier[] = [
  { min: 0, q: 'anime angry slap', veredicto: 'ni con portales de another world... 💔' },
  { min: 20, q: 'anime annoyed', veredicto: 'meh, como agua para perros 🙄' },
  { min: 40, q: 'anime confused', veredicto: 'ni fu ni fa, pura neutralidad 😐' },
  { min: 60, q: 'anime couple cuddle', veredicto: 'se nota la química, eh 💕' },
  { min: 80, q: 'anime couple kiss', veredicto: '¡boda en el santuario YA! 💍✨' },
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

// KLIPY (reemplazo de Tenor, descontinuado 2026): key viaja en el path — JAMÁS
// loguear la URL completa. customer_id es requerido por el endpoint; los
// resultados van en data.items[] con variantes de media (files anidadas o planas).
async function klipyGif(q: string, apiKey: string): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({
      q,
      per_page: '8',
      content_filter: 'low',
      locale: 'us_US',
      customer_id: 'hakkurin',
    });
    const res = await fetch(`https://api.klipy.com/api/v1/${apiKey}/gifs/search?${params}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn(`klipy "${q}": HTTP ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    const items = json?.data?.items ?? json?.data?.gifs ?? json?.data?.results ?? (Array.isArray(json?.data) ? json.data : []);
    const item = items[Math.floor(Math.random() * items.length)];
    // files anidadas (item.files.{gif,webp,...}.url) o variantes planas en el item.
    const files = item?.files && typeof item.files === 'object' ? item.files : item;
    const first = Object.values(files ?? {}).find((f: any) => typeof f?.url === 'string') as any;
    if (!first?.url) logger.warn(`klipy "${q}": respuesta sin gif usable`);
    return first?.url ?? null;
  } catch (e) {
    logger.warn(`klipy "${q}": ${(e as Error).message}`);
    return null;
  }
}

const WAIFU_QUERIES: Record<string, string> = {
  waifu: 'anime waifu',
  husbando: 'anime husbando',
  neko: 'anime neko',
  shinobu: 'shinobu ochaco fanart anime',
  megumin: 'megumin anime',
  awoo: 'anime wolf girl',
};

interface Accion {
  q: string; // query de búsqueda en KLIPY
  con: string; // frase con objetivo
  solo: string; // frase sin objetivo
}

const ACCIONES: Record<string, Accion> = {
  abrazar: { q: 'anime hug', con: 'abraza a', solo: 'reparto abrazos gratis, ¿alguien? 🤗' },
  acariciar: { q: 'anime head pat', con: 'acaricia la cabeza de', solo: 'doy caricias en la cabeza 💗' },
  bofetada: { q: 'anime slap', con: 'bofetea a', solo: 'tengo la mano inquieta... quien caiga, cae 👋' },
  besar: { q: 'anime kiss', con: 'besa a', solo: 'busco a quien besar, hagan fila 😳' },
  morder: { q: 'anime bite', con: 'muerde a', solo: 'ando mordelona hoy, cuidado 🦷' },
  bonk: { q: 'anime bonk', con: 'bonkea a', solo: 'bonk disponible para mentes sucias 🔨' },
  achuchar: { q: 'anime cuddle', con: 'se achucha con', solo: 'necesito achuchones urgentes 🥺' },
};

@Injectable()
export class FunService {
  constructor(private readonly config: ConfigService) {}

  private klipyKey(): string {
    return this.config.get<string>('klipy_api_key', '');
  }

  // Sin key el gif SIEMPRE falta: la nota va en el embed; con key los fallos
  // sólo se degradan en silencio (la razón queda en el log del contenedor).
  private keyNote(): string {
    return this.klipyKey() ? '' : '\n\n🔑 Falta la key KLIPY (WebUI → IA).';
  }

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
    const key = this.klipyKey();
    const gif = await klipyGif(WAIFU_QUERIES[category] ?? 'anime girl', key);
    if (!gif) {
      const msg = key
        ? 'KLIPY no respondió, inténtalo luego... quédate con tu imaginación por hoy.'
        : 'No tengo gifs sin una key de KLIPY — ponla en la WebUI → IA y vuelve.';
      await i.editReply({ embeds: [this.errorEmbed(msg)] }).catch(() => {});
      return;
    }
    const e = this.footer(
      new EmbedBuilder().setTitle('💌 Tu dosis diaria de 2D').setColor(COLOR_WAIFU).setImage(gif),
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
    const gif = await klipyGif(accion.q, this.klipyKey());
    const autor = i.user.displayName ?? i.user.username;
    const objetivo = targetId ? `<@${targetId}>` : null;
    const frase = objetivo ? `**${autor}** ${accion.con} ${objetivo}` : `**${autor}** ${accion.solo}`;
    const e = this.footer(new EmbedBuilder().setDescription(frase + this.keyNote()).setColor(COLOR_WAIFU));
    if (gif) e.setImage(gif);
    if (targetId) e.setThumbnail(i.user.displayAvatarURL());
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleShip(i: ChatInputCommandInteraction, u1: User, u2: User): Promise<void> {
    await i.deferReply().catch(() => {});
    const auto = u1.id === u2.id;
    const pct = auto ? 100 : shipPercent(u1.id, u2.id);
    const { q, veredicto } = shipTags(pct);
    const gif = await klipyGif(q, this.klipyKey());
    const hearts = Math.round(pct / 10);
    const bar = '❤️'.repeat(hearts) + '🖤'.repeat(10 - hearts);
    const nombre = (u: User) => u.displayName ?? u.username;
    const titulo = `${nombre(u1)} 💕 ${nombre(u2)}`;
    const e = this.footer(
      new EmbedBuilder()
        .setTitle(titulo)
        .setColor(COLOR_SHIP)
        .setDescription(`${bar}\n**${pct}%** — ${veredicto}${this.keyNote()}`),
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
