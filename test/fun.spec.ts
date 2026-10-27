import { afterEach, describe, expect, it, vi } from 'vitest';
import { shipPercent, shipTags, uwuify, SHIP_TIERS, FunService } from '../src/discord/infrastructure/fun.service';
import { fill } from '../src/ai/application/ai-prompts';

describe('shipPercent', () => {
  it('es determinista y simétrico', () => {
    const a = shipPercent('111', '222');
    expect(shipPercent('111', '222')).toBe(a);
    expect(shipPercent('222', '111')).toBe(a);
  });

  it('cae en 0..100 y varía entre pares', () => {
    for (const [x, y] of [['1', '2'], ['42', '99'], ['123456789012345678', '987654321098765432']]) {
      const p = shipPercent(x, y);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
    expect(shipPercent('1', '2')).not.toBe(shipPercent('1', '3'));
  });
});

describe('shipTags', () => {
  it('cada rango cae en su tier y el 100 cae en el mejor', () => {
    expect(shipTags(0).min).toBe(0);
    expect(shipTags(19).q).toBe(SHIP_TIERS[0].q);
    expect(shipTags(20).min).toBe(20);
    expect(shipTags(55).min).toBe(40);
    expect(shipTags(100).min).toBe(80);
  });
});

describe('uwuify', () => {
  it('reemplaza l/r (mayúsculas también) y remata con uwu', () => {
    expect(uwuify('Real Lad')).toBe('Weaw Wad uwu');
    expect(uwuify('hola')).toBe('howa uwu');
  });
});

describe('fill', () => {
  it('reemplaza conocidas y deja desconocidas intactas', () => {
    expect(fill('hola {{nombre}} y {{otra}}', { nombre: 'Hakka' })).toBe('hola Hakka y {{otra}}');
    expect(fill('sin vars', {})).toBe('sin vars');
  });
});

// Handlers: fetch global stubbeado por dominio; aserciones sobre el embed que
// llega a editReply (mismo estilo que los tests de music-ui).

function makeConfig(klipyKey = ''): any {
  return { get: (k: string, d?: any) => (k === 'klipy_api_key' ? klipyKey : d ?? '') };
}

function makeInteraction(): any {
  return {
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => ({ id: 'm1' })),
    reply: vi.fn(async () => {}),
    user: { id: 'u1', username: 'Autor', displayName: 'Autor', displayAvatarURL: () => 'http://av/u1' },
  };
}

function embedOf(i: any): any {
  return i.editReply.mock.calls[0][0].embeds[0].data;
}

function user(id: string, name: string): any {
  return { id, displayName: name, username: name, displayAvatarURL: () => `http://av/${id}` };
}

interface Fixtures {
  jikan?: any;
  klipy?: any;
  fail?: 'all' | 'jikan' | 'klipy';
}

function stubFetch(f: Fixtures): any {
  const mock = vi.fn(async (url: any) => {
    const u = String(url);
    const which = u.includes('jikan') ? 'jikan' : u.includes('klipy') ? 'klipy' : '';
    if (f.fail === 'all' || f.fail === which) throw new Error('red caída');
    if (which === 'jikan') return { ok: true, json: async () => f.jikan ?? { data: [] } };
    if (which === 'klipy') return { ok: true, json: async () => f.klipy ?? {} };
    throw new Error(`fetch inesperado: ${u}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('FunService — handlers', () => {
  it('/anime: ficha con título, score, sinopsis e imagen', async () => {
    stubFetch({
      jikan: {
        data: [{
          title: 'Frieren', url: 'https://mal/a', score: 9.1, year: 2023, episodes: 28,
          status: 'Finished Airing', synopsis: 'La maga elfa sigue su camino.',
          images: { jpg: { large_image_url: 'http://img/a.jpg' } },
        }],
      },
    });
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleAnime(i, 'frieren');
    expect(i.deferReply).toHaveBeenCalledTimes(1);
    const e = embedOf(i);
    expect(e.title).toBe('📺 Frieren');
    expect(e.url).toBe('https://mal/a');
    expect(e.description).toContain('maga elfa');
    expect(e.fields).toContainEqual(expect.objectContaining({ name: '⭐ Score', value: '9.1' }));
    expect(e.image.url).toBe('http://img/a.jpg');
  });

  it('/anime: sin resultados y Jikan caído caen en el error embed, sin lanzar', async () => {
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    stubFetch({ jikan: { data: [] } });
    await svc.handleAnime(i, 'no existe');
    expect(embedOf(i).description).toContain('No encontré');

    const i2 = makeInteraction();
    stubFetch({ fail: 'jikan' });
    await svc.handleAnime(i2, 'x');
    expect(embedOf(i2).description).toContain('No encontré');
  });

  it('/manga: autores concatenados y tomos en campos', async () => {
    stubFetch({
      jikan: {
        data: [{
          title: 'Berserk', url: 'https://mal/m', score: 9.3, volumes: 41, chapters: 364,
          authors: [{ name: 'Kentaro Miura' }, { name: 'Kouji Mori' }],
          synopsis: 'Guts.', images: {},
        }],
      },
    });
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleManga(i, 'berserk');
    const e = embedOf(i);
    expect(e.title).toBe('📚 Berserk');
    expect(e.fields).toContainEqual(expect.objectContaining({ name: '✍️ Autor', value: 'Kentaro Miura, Kouji Mori' }));
    expect(e.fields).toContainEqual(expect.objectContaining({ name: '📚 Tomos', value: '41' }));
  });

  it('/temporada: lista numerada con links y scores', async () => {
    stubFetch({
      jikan: {
        data: [
          { title: 'Uno', url: 'https://mal/1', score: 8.1, season: 'fall', year: 2026, images: {} },
          { title: 'Dos', url: 'https://mal/2', score: null, season: 'fall', year: 2026, images: {} },
        ],
      },
    });
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleTemporada(i);
    const e = embedOf(i);
    expect(e.title).toContain('Temporada fall 2026');
    expect(e.description).toContain('`1.` [Uno](https://mal/1) — ⭐ 8.1');
    expect(e.description).toContain('`2.` [Dos](https://mal/2) — ⭐ —');
  });

  it('/waifu: gif de KLIPY con customer_id; sin key y con fallo dan mensajes distintos', async () => {
    const fm = stubFetch({ klipy: { result: true, data: { items: [{ files: { gif: { url: 'http://k/1.gif' } } }] } } });
    const svc = new FunService(makeConfig('KEY-KLIPY'));
    const i = makeInteraction();
    await svc.handleWaifu(i, 'neko');
    expect(embedOf(i).image.url).toBe('http://k/1.gif');
    const url = String(fm.mock.calls[0][0]);
    expect(url).toContain('customer_id=');
    expect(url).toContain('content_filter=low');

    // Con key y KLIPY caído: "no respondió" (la razón queda en el log).
    stubFetch({ fail: 'klipy' });
    const i2 = makeInteraction();
    await svc.handleWaifu(i2, 'neko');
    expect(embedOf(i2).description).toContain('KLIPY no respondió');

    // Sin key: mensaje propio y ni siquiera hay fetch.
    const fm2 = stubFetch({ klipy: {} });
    const i3 = makeInteraction();
    await new FunService(makeConfig()).handleWaifu(i3, 'neko');
    expect(embedOf(i3).description).toContain('key de KLIPY');
    expect(fm2).not.toHaveBeenCalled();
  });

  it('/waifu: acepta variantes planas del item (sin files anidado)', async () => {
    stubFetch({ klipy: { result: true, data: { items: [{ gif: { url: 'http://k/flat.gif' }, max_1mb_gif: { url: 'http://k/big.gif' } }] } } });
    const svc = new FunService(makeConfig('KEY-KLIPY'));
    const i = makeInteraction();
    await svc.handleWaifu(i, 'waifu');
    expect(embedOf(i).image.url).toBe('http://k/flat.gif');
  });

  it('/accion: con objetivo arma "Autor abraza a <@id>"; sin objetivo usa la frase solo', async () => {
    const svc = new FunService(makeConfig('KEY-KLIPY'));
    stubFetch({ klipy: { result: true, data: { items: [{ files: { gif: { url: 'http://k/hug.gif' } } }] } } });
    const i = makeInteraction();
    await svc.handleAccion(i, 'abrazar', '555');
    const e = embedOf(i);
    expect(e.description).toBe('**Autor** abraza a <@555>');
    expect(e.image.url).toBe('http://k/hug.gif');

    const i2 = makeInteraction();
    await new FunService(makeConfig()).handleAccion(i2, 'abrazar', null);
    expect(embedOf(i2).description).toContain('reparto abrazos gratis');

    // Sin key la nota de configuración aparece en el embed.
    const i3 = makeInteraction();
    await new FunService(makeConfig()).handleAccion(i3, 'bonk', null);
    expect(embedOf(i3).description).toContain('Falta la key KLIPY');
  });

  it('/ship: % determinista en la descripción, barra consistente y gif de KLIPY solo con key', async () => {
    const u1 = user('111', 'Ana');
    const u2 = user('222', 'Beto');
    const pct = shipPercent('111', '222');

    stubFetch({ klipy: { result: true, data: { items: [{ files: { gif: { url: 'http://k/love.gif' } } }] } } });
    const svc = new FunService(makeConfig('KEY-KLIPY'));
    const i = makeInteraction();
    await svc.handleShip(i, u1, u2);
    const e = embedOf(i);
    expect(e.title).toBe('Ana 💕 Beto');
    expect(e.description).toContain(`**${pct}%**`);
    expect(e.description).toContain('❤️'.repeat(Math.round(pct / 10)));
    expect(e.thumbnail.url).toBe('http://av/111');
    expect(e.image.url).toBe('http://k/love.gif');

    // Sin key: ni consulta a KLIPY ni imagen, pero el embed sale con la nota.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const i2 = makeInteraction();
    await new FunService(makeConfig()).handleShip(i2, u1, u2);
    const e2 = embedOf(i2);
    expect(e2.description).toContain(`**${pct}%**`);
    expect(e2.description).toContain('Falta la key KLIPY');
    expect(e2.image).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    // Auto-ship: 100% fijo.
    const i3 = makeInteraction();
    await new FunService(makeConfig('KEY')).handleShip(i3, u1, u1);
    expect(embedOf(i3).description).toContain('**100%**');
  });

  it('/uwu: responde el texto transformado; vacío → ephemeral sin transformar', async () => {
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleUwu(i, 'hola mundo');
    expect(i.reply).toHaveBeenCalledWith({ content: 'howa mundo uwu' });

    const i2 = makeInteraction();
    await svc.handleUwu(i2, '   ');
    expect(i2.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});
