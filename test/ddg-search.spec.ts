import { searchDdg } from '../src/ai/ddg-search';

// Scraping de DDG: parseo del HTML, decodificación uddg, fallback de query corta
// y manejo de errores (el mensaje va al modelo, nunca lanza).

const HTML_3 = `
<a class="result-link" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fejemplo.com%2Fun&rut=x" >Título &amp; Uno</a>
<a class="result-snippet" >descripción <b>uno</b></a>
<a class="result-link" href="https://ejemplo.com/dos" >Título Dos</a>
<a class="result-snippet" >desc dos</a>
<a class="result-link" href="/relativo" >Sin URL</a>
<a class="result-snippet" >desc tres</a>
`;

function stubFetch(html: string, status = 200) {
  return vi.fn(async (_url: string) => ({ ok: status < 400, status, text: async () => html }) as any);
}

it('parsea resultados: decodifica uddg, strip de tags y entidades', async () => {
  const f = stubFetch(HTML_3);
  vi.stubGlobal('fetch', f);
  const out = await searchDdg('consulta');
  vi.unstubAllGlobals();
  // El 3er link (/relativo) se descarta (no http) → solo 2 resultados.
  expect(out).toBe('- [Título & Uno](https://ejemplo.com/un): descripción uno\n- [Título Dos](https://ejemplo.com/dos): desc dos');
});

it('máximo 5 resultados', async () => {
  let html = '';
  for (let i = 0; i < 9; i++) {
    html += `<a class="result-link" href="https://e.com/${i}" >T${i}</a><a class="result-snippet" >S${i}</a>`;
  }
  vi.stubGlobal('fetch', stubFetch(html));
  const out = await searchDdg('q');
  vi.unstubAllGlobals();
  expect(out.split('\n').length).toBe(5);
});

it('quita el año 2025 de la query antes de buscar', async () => {
  const f = stubFetch(HTML_3);
  vi.stubGlobal('fetch', f);
  await searchDdg('mejores juegos 2025 indie');
  vi.unstubAllGlobals();
  const url = f.mock.calls[0][0] as string;
  expect(url).toContain('q=mejores%20juegos%20%20indie');
  expect(url).not.toContain('2025');
});

it('<2 resultados y query larga → reintenta con las primeras 4 palabras', async () => {
  const f = vi.fn(async (url: string) => {
    if (String(url).includes('primera%20segunda%20tercera%20cuarta')) {
      return { ok: true, text: async () => '<a class="result-link" href="https://e.com/1" >R</a><a class="result-snippet" >s</a>' } as any;
    }
    return { ok: true, text: async () => '' } as any;
  });
  vi.stubGlobal('fetch', f);
  const out = await searchDdg('primera segunda tercera cuarta quinta sexta');
  vi.unstubAllGlobals();
  expect(f).toHaveBeenCalledTimes(2);
  expect(out).toContain('https://e.com/1');
});

it('HTTP != 2xx → "Error al buscar: DDG HTTP n" (mensaje al modelo, sin lanzar)', async () => {
  vi.stubGlobal('fetch', stubFetch('', 503));
  const out = await searchDdg('q');
  vi.unstubAllGlobals();
  expect(out).toBe('Error al buscar: DDG HTTP 503');
});

it('sin resultados → mensaje explícito', async () => {
  vi.stubGlobal('fetch', stubFetch(''));
  const out = await searchDdg('q corta');
  vi.unstubAllGlobals();
  expect(out).toBe('No se encontraron resultados.');
});

it('error de red → mensaje de error al modelo, sin lanzar', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  const out = await searchDdg('q');
  vi.unstubAllGlobals();
  expect(out).toBe('Error al buscar: ECONNREFUSED');
});
