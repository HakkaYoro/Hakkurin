import { getUrlContext } from '../src/discord/url-context';

// Enriquecimiento de contexto por URL: oEmbed de YouTube + fallback HTML.
// fetchImpl inyectable — sin red real.

function jsonRes(obj: any, ok = true) {
  return { ok, json: async () => obj, text: async () => JSON.stringify(obj) } as any;
}
function textRes(body: string, ok = true) {
  return { ok, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer } as any;
}

it('texto sin URL → contexto vacío sin llamar a fetch', async () => {
  const fetchImpl = vi.fn();
  const ctx = await getUrlContext('hola qué tal', { fetchImpl });
  expect(ctx).toEqual({ text: null, thumbnailData: null, thumbnailMime: null });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('URL de YouTube → oEmbed: título/canal + thumbnail hqdefault', async () => {
  const fetchImpl = vi.fn((url: string) => {
    if (url.includes('oembed')) return Promise.resolve(jsonRes({ title: 'Mi video', author_name: 'Canal X' }));
    return Promise.resolve(textRes('jpeg-bytes'));
  });
  const ctx = await getUrlContext('mira https://www.youtube.com/watch?v=dQw4w9WgXcQ', { fetchImpl });
  expect(ctx.text).toContain('Título del video de YouTube: Mi video');
  expect(ctx.text).toContain('Canal/Autor: Canal X');
  expect(ctx.thumbnailMime).toBe('image/jpeg');
  expect(ctx.thumbnailData!.length).toBeGreaterThan(0);
  const calls = fetchImpl.mock.calls.map((c: any[]) => c[0] as string);
  expect(calls[0]).toContain('oembed?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  expect(calls[1]).toContain('img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
});

it('oEmbed falla → cae al fallback HTML (<title> + meta description)', async () => {
  const html = '<html><head><title>Página &amp; título</title><meta name="description" content="la desc"></head></html>';
  const fetchImpl = vi.fn((url: string) => {
    if (url.includes('oembed')) return Promise.resolve(jsonRes({}, false));
    return Promise.resolve(textRes(html));
  });
  const ctx = await getUrlContext('https://youtu.be/dQw4w9WgXcQ', { fetchImpl });
  // El fallback extrae el <title> verbatim (sin decodificar entidades — igual que el fuente).
  expect(ctx.text).toContain('Título web del enlace: Página &amp; título');
  expect(ctx.text).toContain('Metadescripción: la desc');
  expect(ctx.thumbnailData).toBeNull();
});

it('sitio genérico (no YouTube) → título y metadescripción del HTML', async () => {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(textRes('<title>Docs</title><meta name="description" content="manual">')),
  );
  const ctx = await getUrlContext('visita https://example.com/docs', { fetchImpl });
  expect(ctx.text).toContain('Título web del enlace: Docs');
  expect(ctx.text).toContain('manual');
});

it('todo falla (red muerta) → contexto vacío, sin lanzar', async () => {
  const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
  const ctx = await getUrlContext('https://example.com/x', { fetchImpl });
  expect(ctx.text).toBeNull();
});

it('thumbnail roto pero oEmbed sano → texto presente, thumbnail null', async () => {
  const fetchImpl = vi.fn((url: string) => {
    if (url.includes('oembed')) return Promise.resolve(jsonRes({ title: 'T', author_name: 'A' }));
    return Promise.reject(new Error('thumb down'));
  });
  const ctx = await getUrlContext('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { fetchImpl });
  expect(ctx.text).toContain('Título del video');
  expect(ctx.thumbnailData).toBeNull();
  expect(ctx.thumbnailMime).toBeNull();
});

it('timeout del fetch → contexto vacío (no cuelga el pipeline)', async () => {
  const fetchImpl = vi.fn((..._args: any[]) => new Promise(() => {}) as any); // nunca resuelve
  const ctx = await getUrlContext('https://example.com/lento', { fetchImpl, timeoutMs: 20 });
  expect(ctx.text).toBeNull();
});
