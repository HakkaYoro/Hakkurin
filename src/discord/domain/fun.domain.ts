// Dominio puro de los comandos for-fun: determinismo de /ship, categorías de
// nekos.best, acciones con gif, autocomplete y cache. Sin I/O ni discord.js
// (testeable sin red).

// Determinista: el mismo par SIEMPRE da el mismo % (el destino no cambia).
export function shipPercent(a: string, b: string): number {
  const [x, y] = [a, b].sort();
  let h = 5381;
  for (const c of `${x}:${y}`) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h % 101;
}

export interface ShipTier {
  min: number;
  cat: string; // categoría gif de nekos.best
  veredicto: string;
}

export const SHIP_TIERS: ShipTier[] = [
  { min: 0, cat: 'angry', veredicto: 'ni con portales de another world... 💔' },
  { min: 20, cat: 'confused', veredicto: 'meh, como agua para perros 🙄' },
  { min: 40, cat: 'shrug', veredicto: 'ni fu ni fa, pura neutralidad 😐' },
  { min: 60, cat: 'cuddle', veredicto: 'se nota la química, eh 💕' },
  { min: 80, cat: 'kiss', veredicto: '¡boda en el santuario YA! 💍✨' },
];

export function shipTags(pct: number): ShipTier {
  let tier = SHIP_TIERS[0];
  for (const t of SHIP_TIERS) if (pct >= t.min) tier = t;
  return tier;
}

export function uwuify(text: string): string {
  return `${text.replace(/[lr]/gi, (c) => (c === c.toUpperCase() ? 'W' : 'w')).trim()} uwu`;
}

// Las 4 categorías de imagen que nekos.best expone (gif de acción no hay aquí).
export const WAIFU_CATEGORIES = ['waifu', 'husbando', 'neko', 'kitsune'] as const;

export interface Accion {
  cat: string; // categoría gif de nekos.best
  con?: string; // frase con objetivo; omitir en acciones solistas
  solo: string; // frase sin objetivo
}

// Las 59 categorías gif de nekos.best (api/v2/endpoints), cada una exactamente
// una vez. /accion usa autocomplete: sin límite de choices de Discord.
export const ACCIONES: Record<string, Accion> = {
  abrazar: { cat: 'hug', con: 'abraza a', solo: 'reparto abrazos gratis, ¿alguien? 🤗' },
  acariciar: { cat: 'pat', con: 'acaricia la cabeza de', solo: 'doy caricias en la cabeza 💗' },
  bofetada: { cat: 'slap', con: 'bofetea a', solo: 'tengo la mano inquieta... quien caiga, cae 👋' },
  besar: { cat: 'kiss', con: 'besa a', solo: 'busco a quien besar, hagan fila 😳' },
  morder: { cat: 'bite', con: 'muerde a', solo: 'ando mordelona hoy, cuidado 🦷' },
  bonk: { cat: 'bonk', con: 'bonkea a', solo: 'bonk disponible para mentes sucias 🔨' },
  achuchar: { cat: 'cuddle', con: 'se achucha con', solo: 'necesito achuchones urgentes 🥺' },
  poke: { cat: 'poke', con: 'le da un toque a', solo: 'tengo el dedo inquieto, quien caiga cae 👆' },
  disparar: { cat: 'shoot', con: 'le dispara a', solo: 'pew pew... disparo al aire, por ahora 🔫' },
  mirar: { cat: 'stare', con: 'se queda mirando fijamente a', solo: 'a ver quién pestañea primero 👁️' },
  pico: { cat: 'peck', con: 'da un pico a', solo: 'picos gratis, uno por persona 😚' },
  guinar: { cat: 'wink', con: 'le guiña el ojo a', solo: 'guiño gratuito para quien lo pille 😉' },
  alimentar: { cat: 'feed', con: 'le da un bocado a', solo: '¿quién quiere que le dé de comer? hagan fila 🍡' },
  chocalas: { cat: 'highfive', con: 'choca las manos con', solo: '¡CHOCALAS! no importa quién 🙌' },
  cargar: { cat: 'carry', con: 'carga en brazos a', solo: 'tengo brazos libres, ¿alguien se apunta? 💪' },
  kabedon: { cat: 'kabedon', con: 'hace kabedon a', solo: '*kabedon a la pared*, salió solito 😤' },
  patear: { cat: 'kick', con: 'patea a', solo: 'patada voladora al aire 🦵' },
  golpear: { cat: 'punch', con: 'le suelta un puñetazo a', solo: 'puñetazos al aire, mi saco de boxeo favorito 🥊' },
  estrechar: { cat: 'handshake', con: 'estrecha la mano de', solo: 'mano extendida, sin trampas 🤝' },
  manita: { cat: 'handhold', con: 'le toma la manita a', solo: 'busco manita libre que sostener 🥺' },
  almohada: { cat: 'lappillow', con: 'usa de almohada a', solo: 'necesito un regazo donde recostarme 😴' },
  lanzar_beso: { cat: 'blowkiss', con: 'le lanza un beso volado a', solo: 'besos volados, a ver a quién caen 😘' },
  cosquillas: { cat: 'tickle', con: 'le hace cosquillas a', solo: 'tengo plumitas, vengan si se atreven 🪶' },
  yeet: { cat: 'yeet', con: 'le lanza un yeet a', solo: 'YEET 🚀' },
  baka: { cat: 'baka', con: 'le dice BAKA a', solo: 'bakas por doquier, este server no cambia 🙄' },
  bailar: { cat: 'dance', con: 'baila con', solo: 'se echa un bailecito sin razón alguna 💃' },
  acechar: { cat: 'lurk', solo: 'ando en modo ninja, observando desde las sombras 👀' },
  dormir: { cat: 'sleep', solo: 'zzz... cinco minutitos más 😴' },
  aplaudir: { cat: 'clap', solo: 'aplauso, aplauso para todos 👏' },
  hombros: { cat: 'shrug', solo: '¯\\_(ツ)_/¯ tampoco sabe' },
  saludar: { cat: 'wave', solo: 'holaa, pasaba a saludar 👋' },
  sonreir: { cat: 'smile', solo: 'hoy ando con sonrisa de oreja a oreja 😊' },
  sorbo: { cat: 'sip', solo: 'sorbe su té con elegancia ☕' },
  sonrojarse: { cat: 'blush', solo: 'n-no es que me sonroje ni nada, baka 😳' },
  presumir: { cat: 'smug', solo: 'obvio que soy la mejor, ¿debate? no 😏' },
  pensar: { cat: 'think', solo: 'pensando... mis neuronas están cargando, esperen 🤔' },
  risita: { cat: 'teehee', solo: 'teehee~ 😝' },
  shock: { cat: 'shocked', solo: '¿¡QUÉ!? ¿nadie pensó en avisarme? 😱' },
  lengua: { cat: 'bleh', solo: 'bleeeh 🤪' },
  aburrida: { cat: 'bored', solo: 'qué aburrido está todo hoy, entreténganme 😑' },
  nam: { cat: 'nom', solo: 'nam nam nam 🍙' },
  nya: { cat: 'nya', solo: 'nya~ 🐱' },
  bostezar: { cat: 'yawn', solo: 'qué sueño... y ni me levanté tarde 🥱' },
  facepalm: { cat: 'facepalm', solo: 'no puede ser, qué vergüenza ajena 🤦' },
  alegre: { cat: 'happy', solo: 'hoy ando feliz y nadie me lo quita 🥳' },
  girar: { cat: 'spin', solo: 'girando y girando, me marea bonito 🌀' },
  temblar: { cat: 'shake', solo: 'brrr... ¿hace frío o es el misterio? 🥶' },
  correr: { cat: 'run', solo: '¡CORRAN! yo voy primero 🏃' },
  asentir: { cat: 'nod', solo: 'asiente con sapiencia, ahora todo tiene sentido 🙂' },
  negar: { cat: 'nope', solo: 'nope. ni hablar. jamás. ❌' },
  llorar: { cat: 'cry', solo: 'snif... ¿nadie me quiere hoy? 😭' },
  puchero: { cat: 'pout', solo: '*pucheros* no es justo 🎈' },
  militar: { cat: 'salute', solo: '*saludo militar* a sus órdenes 🫡' },
  pulgar: { cat: 'thumbsup', solo: 'aprobado por la gerente 👍' },
  reir: { cat: 'laugh', solo: 'JAJAJA no puedo, me muero 😂' },
  tirar_mesa: { cat: 'tableflip', solo: '(╯°□°）╯︵ ┻━┻ ¡ya basta!' },
  confundida: { cat: 'confused', solo: '¿eh? no entendí ni papa 🤨' },
  enojada: { cat: 'angry', solo: 'GRRC, ¿así que me tratan? 😡' },
  colita: { cat: 'wag', solo: 'muevo la colita de la felicidad 🐶' },
};

// Datos del embed de una acción, agnósticos de discord.js: smart-response los
// manda vía MessageTransportPort.sendEmbed, FunService los convierte a EmbedBuilder.
export interface AccionEmbedData {
  description: string;
  image?: string;
  thumbnail?: string;
}

export function accionEmbedData(
  autor: string,
  autorAvatar: string | null,
  tipo: string,
  targetId: string | null,
  hit: NekosHit | null,
): AccionEmbedData | null {
  const accion = ACCIONES[tipo];
  if (!accion) return null;
  // Acción solista con target: se ignora el objetivo, manda la frase solo.
  const objetivo = targetId && accion.con ? `<@${targetId}>` : null;
  const frase = objetivo ? `**${autor}** ${accion.con} ${objetivo}` : `**${autor}** ${accion.solo}`;
  return {
    description: frase + (hit ? nekosCredit(hit) : ''),
    image: hit?.url,
    thumbnail: objetivo ? (autorAvatar ?? undefined) : undefined,
  };
}

// Autocomplete de /accion: busca por clave y por categoría nekos ("mor" →
// morder, "hug" → abrazar). Discord admite máx 25 opciones por respuesta.
export function filtrarAcciones(query: string): string[] {
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = norm(query.trim());
  const keys = Object.keys(ACCIONES).sort();
  if (!q) return keys.slice(0, 25);
  return keys.filter((k) => norm(k).includes(q) || ACCIONES[k].cat.includes(q)).slice(0, 25);
}

// Valida la acción que el LLM quiere hacer: tipo conocido, target real del
// contexto y jamás contra sí misma. Solista con target → se degrada a solista.
export function resolverAccionBot(
  accion: { tipo: string; target: string | null } | null | undefined,
  activos: string[],
  botId: string | null,
): { tipo: string; target: string | null } | null {
  const tipo = accion?.tipo?.trim().toLowerCase();
  if (!tipo || !ACCIONES[tipo]) return null;
  const target = accion!.target?.trim() || null;
  if (target && (target === botId || !activos.includes(target))) return null;
  return { tipo, target: target && ACCIONES[tipo].con ? target : null };
}

// Respuesta real: { results: [{ url, dimensions, anime_name | artist_name/artist_href }] }
export interface NekosHit {
  url: string;
  anime_name?: string;
  artist_name?: string;
  artist_href?: string;
}

export function nekosLista(json: any): NekosHit[] {
  const results = json?.results;
  return Array.isArray(results) ? results.filter((r) => typeof r?.url === 'string') : [];
}

// Crédito corto para el embed: el gif nombra su anime, la imagen a su artista.
export function nekosCredit(hit: NekosHit): string {
  if (hit.anime_name) return `\n\n📺 *${hit.anime_name}*`;
  if (hit.artist_name) {
    const nombre = hit.artist_href ? `[${hit.artist_name}](${hit.artist_href})` : hit.artist_name;
    return `\n\n🎨 *${nombre}*`;
  }
  return '';
}

// Cache de URLs de nekos.best: entrada viva 3 días como máximo (vencida no se
// sirve aunque la red caiga), pool acotado por categoría.
export interface CachedNekos extends NekosHit {
  ts: number;
}
export const NEKOS_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const NEKOS_POOL_CAP = 32;

export function purgarExpiradas(pool: CachedNekos[], ahora: number, ttl = NEKOS_TTL_MS): CachedNekos[] {
  return pool.filter((e) => ahora - e.ts < ttl);
}

export function mezclarPool(
  pool: CachedNekos[],
  frescos: NekosHit[],
  ahora: number,
  cap = NEKOS_POOL_CAP,
): CachedNekos[] {
  const porUrl = new Map<string, CachedNekos>(pool.map((e) => [e.url, e]));
  for (const f of frescos) if (!porUrl.has(f.url)) porUrl.set(f.url, { ...f, ts: ahora });
  const lista = [...porUrl.values()];
  // Los frescos quedan al final: el cap descarta los más viejos.
  return lista.length <= cap ? lista : lista.slice(-cap);
}
