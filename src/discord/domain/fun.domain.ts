// Dominio puro de los comandos for-fun: determinismo de /ship, categorías de
// nekos.best y parseo de su respuesta. Sin I/O ni discord.js (testeable sin red).

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
  con: string; // frase con objetivo
  solo: string; // frase sin objetivo
}

export const ACCIONES: Record<string, Accion> = {
  abrazar: { cat: 'hug', con: 'abraza a', solo: 'reparto abrazos gratis, ¿alguien? 🤗' },
  acariciar: { cat: 'pat', con: 'acaricia la cabeza de', solo: 'doy caricias en la cabeza 💗' },
  bofetada: { cat: 'slap', con: 'bofetea a', solo: 'tengo la mano inquieta... quien caiga, cae 👋' },
  besar: { cat: 'kiss', con: 'besa a', solo: 'busco a quien besar, hagan fila 😳' },
  morder: { cat: 'bite', con: 'muerde a', solo: 'ando mordelona hoy, cuidado 🦷' },
  bonk: { cat: 'bonk', con: 'bonkea a', solo: 'bonk disponible para mentes sucias 🔨' },
  achuchar: { cat: 'cuddle', con: 'se achucha con', solo: 'necesito achuchones urgentes 🥺' },
};

// Respuesta real: { results: [{ url, dimensions, anime_name | artist_name/artist_href }] }
export interface NekosHit {
  url: string;
  anime_name?: string;
  artist_name?: string;
  artist_href?: string;
}

export function nekosPick(json: any): NekosHit | null {
  const results = json?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const hit = results[Math.floor(Math.random() * results.length)];
  return typeof hit?.url === 'string' ? hit : null;
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
