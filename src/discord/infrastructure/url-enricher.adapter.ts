import { Injectable } from '@nestjs/common';
import { UrlContext, UrlEnricherPort } from '../domain/ports/url-enricher.port';

// ponytail: sólo oEmbed de YouTube + fallback HTML <title>/<meta description>;
// el path yt-dlp para metadata se omitió (frágil, caía casi siempre) — el sidecar
// se reserva para audio. Upgrade: un enricher más rico si hace falta.

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

  const yt = url.match(YT_RE);
  if (yt) {
    const videoId = yt[1];
    try {
      const res = await fetchImpl(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) },
      );
      if (res.ok) {
        const info: any = await res.json();
        const text = `Título del video de YouTube: ${info.title ?? 'Video'}\nCanal/Autor: ${info.author_name ?? 'Desconocido'}`;
        let thumb: Buffer | null = null;
        try {
          const tRes = await fetchImpl(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (tRes.ok) thumb = Buffer.from(await tRes.arrayBuffer());
        } catch {
        }
        return { text, thumbnailData: thumb, thumbnailMime: thumb ? 'image/jpeg' : null };
      }
    } catch {
    }
  }

  // Fallback HTML: posible bot-protection; sin contexto.
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
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
  }
  return empty;
}

@Injectable()
export class UrlEnricherAdapter extends UrlEnricherPort {
  enrich(userText: string): Promise<UrlContext> {
    return getUrlContext(userText);
  }
}
