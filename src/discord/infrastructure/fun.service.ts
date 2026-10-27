// Comandos for-fun (anime/otaku): Jikan para fichas, nekos.best para gifs e
// imágenes (gratis, sin key). Embeds al estilo de music-ui: título con emoji,
// color por familia, footer del bot, thumbnail/imagen cuando aporta.
import { mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Injectable, Inject, Logger } from '@nestjs/common';
import { EmbedBuilder, type ChatInputCommandInteraction, type User } from 'discord.js';
import { ConfigService } from '../../common/config.service';
import { atomicWrite, delay } from '../../common/util';
import { AiBrain } from '../../ai/domain/ports/ai-brain.port';
import { PROMPT_ACCION, fill } from '../../ai/application/ai-prompts';
import { BOT_SELF_ID, MemoryService } from '../../memory/application/memory.service';
import {
  ACCIONES,
  accionEmbedData,
  type AccionEmbedData,
  type CachedNekos,
  mezclarPool,
  nekosCredit,
  nekosLista,
  purgarExpiradas,
  shipPercent,
  shipTags,
  uwuify,
  WAIFU_CATEGORIES,
  type NekosHit,
} from '../domain/fun.domain';

const logger = new Logger('fun');

// Paleta otaku: info=violeta, waifu/acción=rosa, ship=fucsia.
const COLOR_INFO = 0x9b59b6;
const COLOR_WAIFU = 0xff69b4;
const COLOR_SHIP = 0xe91e63;

const NEKOS_CACHE_FILE = 'data/nekos-cache.json';
// Cooldown de la reacción LLM al /accion dirigido a Hakkurin: frena spam manual
// del comando (cada reacción es una llamada al modelo).
const REACCION_COOLDOWN_MS = 60_000;

//ponytail: fetch de Jikan sin cache ni retry; rate-limit 60/min sobra para un bot casero.
async function jikanGet(path: string, ua: string): Promise<any | null> {
  try {
    const res = await fetch(`https://api.jikan.moe/v4${path}`, {
      headers: { 'User-Agent': ua },
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

async function nekosGet(cat: string, ua: string): Promise<NekosHit[]> {
  try {
    const res = await fetch(`https://nekos.best/api/v2/${cat}?amount=8`, {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn(`nekos "${cat}": HTTP ${res.status}`);
      return [];
    }
    const lista = nekosLista(await res.json());
    if (!lista.length) logger.warn(`nekos "${cat}": respuesta sin resultados`);
    return lista;
  } catch (e) {
    logger.warn(`nekos "${cat}": ${(e as Error).message}`);
    return [];
  }
}

@Injectable()
export class FunService {
  private nekosPool: Record<string, CachedNekos[]> | null = null;
  private ultimaReaccion = 0;

  constructor(
    private readonly config: ConfigService,
    @Inject(AiBrain) private readonly brain: AiBrain,
    private readonly memory: MemoryService,
  ) {}

  // nekos.best bloquea UAs genéricos/placeholder ("Discord bot"); exige APP_NAME (CONTACTO) real.
  private get ua(): string {
    return `Hakkurin/1.0 (${this.config.get<string>('bot_contact')})`;
  }

  private footer(e: EmbedBuilder): EmbedBuilder {
    return e.setFooter({ text: `${this.config.get('bot_name', 'Hakkurin')} ♡` }).setTimestamp();
  }

  private errorEmbed(msg: string): EmbedBuilder {
    return this.footer(new EmbedBuilder().setTitle('😖').setDescription(msg).setColor(COLOR_INFO));
  }

  private pool(): Record<string, CachedNekos[]> {
    if (!this.nekosPool) {
      try {
        const parsed = JSON.parse(readFileSync(NEKOS_CACHE_FILE, 'utf8'));
        this.nekosPool = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        this.nekosPool = {};
      }
    }
    return this.nekosPool!;
  }

  /** Gif/imagen de una categoría: del pool vivo (TTL 3 días) o fetch fresco.
   *  ponytail: sin lock — dos comandos simultáneos pueden fetchear doble; el
   *  merge dedupea y no rompe nada. Upgrade: cola si algún día molesta. */
  private async nekosCached(cat: string): Promise<NekosHit | null> {
    const pool = this.pool();
    const ahora = Date.now();
    const vivos = purgarExpiradas(pool[cat] ?? [], ahora);
    if (vivos.length) {
      pool[cat] = vivos;
      return vivos[Math.floor(Math.random() * vivos.length)];
    }
    const frescos = await nekosGet(cat, this.ua);
    pool[cat] = mezclarPool(vivos, frescos, ahora);
    if (!pool[cat].length) return null;
    void mkdir(path.dirname(NEKOS_CACHE_FILE), { recursive: true })
      .then(() => atomicWrite(NEKOS_CACHE_FILE, JSON.stringify(pool)))
      .catch((e) => logger.warn(`cache: ${(e as Error).message}`));
    return pool[cat][Math.floor(Math.random() * pool[cat].length)];
  }

  async handleAnime(i: ChatInputCommandInteraction, query: string): Promise<void> {
    await i.deferReply().catch(() => {});
    const json = await jikanGet(`/anime?q=${encodeURIComponent(query)}&limit=1&sfw=true`, this.ua);
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
    const json = await jikanGet(`/manga?q=${encodeURIComponent(query)}&limit=1&sfw=true`, this.ua);
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
    const json = await jikanGet('/seasons/now?sfw=true&limit=10', this.ua);
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
    const hit = await this.nekosCached(category);
    if (!hit) {
      await i.editReply({ embeds: [this.errorEmbed('nekos.best no respondió, inténtalo luego... quédate con tu imaginación por hoy.')] }).catch(() => {});
      return;
    }
    const e = this.footer(
      new EmbedBuilder().setTitle('💌 Tu dosis diaria de 2D').setColor(COLOR_WAIFU).setImage(hit.url),
    );
    const credit = nekosCredit(hit).trim();
    if (credit) e.setDescription(credit);
    await i.editReply({ embeds: [e] }).catch(() => {});
  }

  async handleAccion(i: ChatInputCommandInteraction, tipo: string, targetId: string | null): Promise<void> {
    await i.deferReply().catch(() => {});
    const accion = ACCIONES[tipo];
    if (!accion) {
      await i.editReply({ embeds: [this.errorEmbed('No conozco esa acción, baka.')] }).catch(() => {});
      return;
    }
    const autor = i.user.displayName ?? i.user.username;
    const hit = await this.nekosCached(accion.cat);
    const data = accionEmbedData(autor, i.user.displayAvatarURL(), tipo, targetId, hit)!;
    const e = this.footer(new EmbedBuilder().setDescription(data.description).setColor(COLOR_WAIFU));
    if (data.image) e.setImage(data.image);
    if (data.thumbnail) e.setThumbnail(data.thumbnail);
    await i.editReply({ embeds: [e] }).catch(() => {});
    if (targetId && targetId === i.client?.user?.id) {
      await this.reaccionar(i, tipo, autor, i.user.id);
    }
  }

  /** Hakkurin reacciona en persona cuando le hacen una acción: respuesta
   *  conversacional del LLM tras el embed. Nada de esto rompe el comando. */
  private async reaccionar(
    i: ChatInputCommandInteraction,
    tipo: string,
    autor: string,
    autorId: string,
  ): Promise<void> {
    if (Date.now() - this.ultimaReaccion < REACCION_COOLDOWN_MS) return;
    this.ultimaReaccion = Date.now();
    try {
      // ponytail: cooldown en memoria — un restart lo resetea; el freno real es
      // que /accion es manual. Upgrade: persistir si algún día spamea cruzando restarts.
      const accion = ACCIONES[tipo];
      const perfil = ((await this.memory.getMemory(autorId)).summary || 'sin datos').slice(0, 600);
      const prompt = fill(this.config.get('prompt_accion') || PROMPT_ACCION, {
        accion: `${autor} ${accion.con ?? 'interactúa con'} Hakkurin (gif: ${accion.cat})`,
        nombre: autor,
        perfil,
      });
      const resp = (await this.brain.generateResponse(prompt, autorId, autor))?.trim();
      if (!resp) return;
      const ch: any = i.channel;
      if (ch?.sendTyping) await ch.sendTyping().catch(() => {});
      await delay(800 + Math.random() * 1500);
      await i.followUp({ content: resp.slice(0, 1900) }).catch(() => {});
      await this.memory.addInteraction(BOT_SELF_ID, `[SISTEMA] ${autor} usó /accion ${tipo} conmigo; respondí: ${resp}`);
    } catch (e) {
      logger.warn(`reacción a /accion: ${(e as Error).message}`);
    }
  }

  /** Acción iniciada por el propio bot (campo accion del AnalysisResult):
   *  devuelve los datos del embed para que smart-response los mande al canal. */
  async accionParaCanal(tipo: string, autor: string, targetId: string | null): Promise<AccionEmbedData | null> {
    const accion = ACCIONES[tipo];
    if (!accion) return null;
    const hit = await this.nekosCached(accion.cat);
    return accionEmbedData(autor, null, tipo, targetId, hit);
  }

  async handleShip(i: ChatInputCommandInteraction, u1: User, u2: User): Promise<void> {
    await i.deferReply().catch(() => {});
    const auto = u1.id === u2.id;
    const pct = auto ? 100 : shipPercent(u1.id, u2.id);
    const { cat, veredicto } = shipTags(pct);
    const hit = await this.nekosCached(cat);
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
