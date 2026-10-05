// DuckDuckGo no tiene lib JS equivalente a `ddgs` → scraping del endpoint HTML.
// ponytail: scraping frágil — si rompe, meter una lib dedicada (duck-duck-scrape).

const DDG_URL = 'https://html.duckduckgo.com/html/';

function buildResult(title: string, link: string, snippet: string): string {
  return `- [${title}](${link}): ${snippet}`;
}

export async function searchDdg(rawQuery: string): Promise<string> {
  // Limpieza proactiva: quitar año para evitar resultados demasiado específicos/vacíos.
  let query = rawQuery.replace(/2025/g, '').trim();

  try {
    let results = await ddgText(query);
    if (results.length < 2 && query.split(/\s+/).length > 4) {
      const simple = query.split(/\s+/).slice(0, 4).join(' ');
      results = results.concat(await ddgText(simple));
    }
    if (!results.length) return 'No se encontraron resultados.';
    return results.join('\n');
  } catch (e: any) {
    // El error se devuelve al modelo para que reaccione; nunca lanza.
    return `Error al buscar: ${e.message ?? e}`;
  }
}

async function ddgText(query: string): Promise<string[]> {
  const url = `${DDG_URL}?q=${encodeURIComponent(query)}&kl=ve-es`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Hakkurin/2.0 (Discord bot)' },
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const html = await res.text();
  return parseResults(html).slice(0, 5);
}

// El HTML de DDG mete cada resultado en <a class="result-link" href=URL>...</a>
// y el snippet en <a class="result-snippet" ...>. Extraemos con regex.
function parseResults(html: string): string[] {
  const out: string[] = [];
  // Los enlaces reales van dentro de redirect (uddg=). Tomamos el href del result-link.
  const linkRe =
    /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const rawUrl = decodeUddg(m[1]);
    const title = stripTags(m[2]).trim();
    if (rawUrl && title) links.push({ url: rawUrl, title });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }

  for (let i = 0; i < links.length; i++) {
    out.push(buildResult(links[i].title, links[i].url, snippets[i] || ''));
  }
  return out;
}

function decodeUddg(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  return href.startsWith('http') ? href : '';
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
}
