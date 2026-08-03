// Puerto del enriquecimiento de contexto por URL (discord_client.py:493-590).
// ponytail: versión lean — oEmbed de YouTube (título/autor + thumbnail) y fallback
// HTML <title>/<meta description>. Se OMITE el path de yt-dlp para metadata (flaco,
// timeout 5s, caía casi siempre según los comentarios del fuente); el sidecar
// yt-dlp se reserva para extracción de audio (Phase 4). Añadir si hace falta richer.

export interface UrlContext {
  text: string | null;
  thumbnailData: Buffer | null;
  thumbnailMime: string | null;
}

const YT_RE = /(?:v=|\/|youtu\.be\/)([0-9A-Za-z_-]{11})/;
const URL_RE = /https?:\/\/\S+/;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function getUrlContext(
  userText: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<UrlContext> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const match = userText.match(URL_RE);
  const empty: UrlContext = { text: null, thumbnailData: null, thumbnailMime: null };
  if (!match) return empty;
  const url = match[0];

  // YouTube → oEmbed + thumbnail predecible de ytimg.
  const yt = url.match(YT_RE);
  if (yt) {
    const videoId = yt[1];
    try {
      const res = await withTimeout(
        fetchImpl(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { headers: { 'User-Agent': UA } },
        ),
        timeoutMs,
      );
      if (res.ok) {
        const info: any = await res.json();
        const text = `Título del video de YouTube: ${info.title ?? 'Video'}\nCanal/Autor: ${info.author_name ?? 'Desconocido'}`;
        let thumb: Buffer | null = null;
        try {
          const tRes = await withTimeout(
            fetchImpl(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, {
              headers: { 'User-Agent': UA },
            }),
            timeoutMs,
          );
          if (tRes.ok) thumb = Buffer.from(await tRes.arrayBuffer());
        } catch {
          /* thumbnail opcional */
        }
        return { text, thumbnailData: thumb, thumbnailMime: thumb ? 'image/jpeg' : null };
      }
    } catch {
      /* cae al fallback genérico */
    }
  }

  // Fallback genérico: HTML <title> + <meta description>.
  try {
    const res = await withTimeout(fetchImpl(url, { headers: { 'User-Agent': UA } }), timeoutMs);
    if (!res.ok) return empty;
    const html = await res.text();
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const desc = html
      .match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i)?.[1]
      ?.trim();
    if (title || desc) {
      return { text: `Título web del enlace: ${title ?? 'Sin título'}\nMetadescripción: ${desc ?? 'Sin descripción'}`, thumbnailData: null, thumbnailMime: null };
    }
  } catch {
    /* posible bot-protection; sin contexto */
  }
  return empty;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}
