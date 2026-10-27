import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delay } from '../src/common/util';
import {
  ACCIONES,
  accionEmbedData,
  filtrarAcciones,
  mezclarPool,
  nekosCredit,
  nekosLista,
  purgarExpiradas,
  resolverAccionBot,
  shipPercent,
  shipTags,
  SHIP_TIERS,
  uwuify,
  WAIFU_CATEGORIES,
  NEKOS_POOL_CAP,
  NEKOS_TTL_MS,
  type CachedNekos,
  type NekosHit,
} from '../src/discord/domain/fun.domain';
import { FunService } from '../src/discord/infrastructure/fun.service';

describe('dominio fun', () => {
  it('shipPercent es determinista, simétrico y cae en 0..100', () => {
    const a = shipPercent('111', '222');
    expect(shipPercent('111', '222')).toBe(a);
    expect(shipPercent('222', '111')).toBe(a);
    for (const [x, y] of [['1', '2'], ['42', '99'], ['123456789012345678', '987654321098765432']]) {
      expect(shipPercent(x, y)).toBeLessThanOrEqual(100);
    }
    expect(shipPercent('1', '2')).not.toBe(shipPercent('1', '3'));
  });

  it('shipTags mapea cada rango a su categoría de nekos.best y el 100 al mejor tier', () => {
    expect(shipTags(0).cat).toBe(SHIP_TIERS[0].cat);
    expect(shipTags(19).cat).toBe('angry');
    expect(shipTags(25).cat).toBe('confused');
    expect(shipTags(55).cat).toBe('shrug');
    expect(shipTags(70).cat).toBe('cuddle');
    expect(shipTags(100).cat).toBe('kiss');
  });

  it('uwuify reemplaza l/r (mayúsculas también) y remata con uwu', () => {
    expect(uwuify('Real Lad')).toBe('Weaw Wad uwu');
    expect(uwuify('hola')).toBe('howa uwu');
  });

  it('nekosLista filtra results con url y devuelve [] sin resultados', () => {
    expect(nekosLista({ results: [{ url: 'http://n/1.gif' }, { sin: 'url' }, { url: 'http://n/2.gif' }] })).toEqual([
      { url: 'http://n/1.gif' },
      { url: 'http://n/2.gif' },
    ]);
    expect(nekosLista({ results: [] })).toEqual([]);
    expect(nekosLista({})).toEqual([]);
    expect(nekosLista(null)).toEqual([]);
  });

  it('nekosCredit acredita al anime (gif) o al artista (imagen), vacío si no hay', () => {
    expect(nekosCredit({ url: 'u', anime_name: 'Hoshikuzu Telepath' })).toContain('Hoshikuzu Telepath');
    expect(nekosCredit({ url: 'u', artist_name: 'Nana', artist_href: 'http://a/nana' })).toContain('[Nana](http://a/nana)');
    expect(nekosCredit({ url: 'u', artist_name: 'Nana' })).toContain('Nana');
    expect(nekosCredit({ url: 'u' })).toBe('');
  });

  it('ACCIONES cubre las categorías gif de nekos.best sin repetir y conserva las 7 originales', () => {
    const claves = Object.keys(ACCIONES);
    expect(claves.length).toBeGreaterThanOrEqual(55);
    for (const original of ['abrazar', 'acariciar', 'bofetada', 'besar', 'morder', 'bonk', 'achuchar']) {
      expect(ACCIONES[original]).toBeTruthy();
    }
    const cats = Object.values(ACCIONES).map((a) => a.cat);
    expect(new Set(cats).size).toBe(cats.length);
    for (const a of Object.values(ACCIONES)) {
      expect(a.cat).toBeTruthy();
      expect(a.solo).toBeTruthy();
      // Acción con "con" debe distinguirse de la solista (frases distintas).
      if (a.con) expect(a.con).not.toBe(a.solo);
    }
  });

  it('accionEmbedData arma frase con objetivo, solista, ignora target en solistas y null en tipo desconocido', () => {
    const hit: NekosHit = { url: 'http://n/hug.gif', anime_name: 'Nisekoi' };
    const con = accionEmbedData('Ana', 'http://av/ana', 'abrazar', '555', hit)!;
    expect(con.description).toContain('**Ana** abraza a <@555>');
    expect(con.description).toContain('Nisekoi');
    expect(con.image).toBe('http://n/hug.gif');
    expect(con.thumbnail).toBe('http://av/ana');

    const solo = accionEmbedData('Ana', 'http://av/ana', 'abrazar', null, null)!;
    expect(solo.description).toContain('**Ana** reparto abrazos gratis');
    expect(solo.image).toBeUndefined();
    expect(solo.thumbnail).toBeUndefined();

    // Solista pura con target: el objetivo se ignora, manda la frase solo.
    const purista = accionEmbedData('Ana', null, 'dormir', '555', null)!;
    expect(purista.description).toContain('**Ana** zzz');
    expect(purista.thumbnail).toBeUndefined();

    expect(accionEmbedData('Ana', null, 'inexistente', null, null)).toBeNull();
  });

  it('filtrarAcciones busca por clave y por categoría nekos, y acota a 25', () => {
    expect(filtrarAcciones('mor')).toEqual(['morder']);
    expect(filtrarAcciones('morder')).toEqual(['morder']);
    expect(filtrarAcciones('hug')).toEqual(['abrazar']); // por categoría nekos
    expect(filtrarAcciones('  BONK  ')).toEqual(['bonk']);
    expect(filtrarAcciones('')).toHaveLength(25);
    expect(filtrarAcciones('zzzznada')).toEqual([]);
    // Sin query devuelve las primeras 25 ordenadas.
    const todas = Object.keys(ACCIONES).sort();
    expect(filtrarAcciones('')).toEqual(todas.slice(0, 25));
  });

  it('resolverAccionBot valida tipo, target real y jamás el auto-objetivo', () => {
    const activos = ['u1', 'u2'];
    expect(resolverAccionBot({ tipo: 'Morder ', target: 'u2' }, activos, 'bot')).toEqual({
      tipo: 'morder',
      target: 'u2',
    });
    expect(resolverAccionBot({ tipo: 'dormir', target: null }, activos, 'bot')).toEqual({ tipo: 'dormir', target: null });
    // Solista con target: se degrada a solista en vez de rechazarse.
    expect(resolverAccionBot({ tipo: 'dormir', target: 'u1' }, activos, 'bot')).toEqual({ tipo: 'dormir', target: null });
    expect(resolverAccionBot({ tipo: 'inexistente', target: 'u1' }, activos, 'bot')).toBeNull();
    expect(resolverAccionBot({ tipo: 'morder', target: 'fantasma' }, activos, 'bot')).toBeNull();
    expect(resolverAccionBot({ tipo: 'morder', target: 'bot' }, activos, 'bot')).toBeNull();
    expect(resolverAccionBot(null, activos, 'bot')).toBeNull();
    expect(resolverAccionBot(undefined, activos, 'bot')).toBeNull();
  });

  it('purgarExpiradas: el borde de 3 días expira; lo vigente queda', () => {
    const ahora = 1_000_000;
    const pool: CachedNekos[] = [
      { url: 'vieja', ts: ahora - NEKOS_TTL_MS - 1 },
      { url: 'borde', ts: ahora - NEKOS_TTL_MS },
      { url: 'viva', ts: ahora - NEKOS_TTL_MS + 1 },
    ];
    expect(purgarExpiradas(pool, ahora).map((e) => e.url)).toEqual(['viva']);
  });

  it('mezclarPool dedupea por url y el cap conserva los más nuevos', () => {
    const viejos: CachedNekos[] = [
      { url: 'a', ts: 1 },
      { url: 'b', ts: 2 },
    ];
    const mezclados = mezclarPool(viejos, [{ url: 'b', anime_name: 'duplicado' }, { url: 'c' }], 10);
    expect(mezclados).toEqual([
      { url: 'a', ts: 1 },
      { url: 'b', ts: 2 }, // duplicado: gana el ts original
      { url: 'c', ts: 10 },
    ]);

    const llenos: CachedNekos[] = Array.from({ length: NEKOS_POOL_CAP }, (_, i) => ({ url: `v${i}`, ts: i }));
    const conCap = mezclarPool(llenos, [{ url: 'nuevo' }], 999);
    expect(conCap).toHaveLength(NEKOS_POOL_CAP);
    expect(conCap.at(-1)!.url).toBe('nuevo');
    expect(conCap[0].url).toBe('v1'); // el más viejo (v0) fue descartado
  });

  it('WAIFU_CATEGORIES sigue siendo el grupo de imágenes', () => {
    expect(WAIFU_CATEGORIES).toEqual(['waifu', 'husbando', 'neko', 'kitsune']);
  });
});

// Handlers: fetch global stubbeado por dominio; aserciones sobre el embed que
// llega a editReply (mismo estilo que los tests de music-ui). El cache de
// nekos vive en data/nekos-cache.json → cada test arranca con disco limpio:
// primero se deja aterrizar la escritura fire-and-forget del test previo.

function limpiarData() {
  return delay(30).then(() => rmSync('data', { recursive: true, force: true }));
}

function makeConfig(): any {
  return { get: (k: string, d?: any) => (k === 'bot_name' ? 'Hakkurin' : d ?? '') };
}

function makeInteraction(): any {
  return {
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => ({ id: 'm1' })),
    reply: vi.fn(async () => {}),
    followUp: vi.fn(async () => ({})),
    user: { id: 'u1', username: 'Autor', displayName: 'Autor', displayAvatarURL: () => 'http://av/u1' },
    client: { user: { id: 'bot1' } },
    channel: { sendTyping: vi.fn(async () => {}) },
  };
}

function embedOf(i: any): any {
  return i.editReply.mock.calls[0][0].embeds[0].data;
}

function user(id: string, name: string): any {
  return { id, displayName: name, username: name, displayAvatarURL: () => `http://av/${id}` };
}

function makeBrain(resp: string | null = null): any {
  return { generateResponse: vi.fn(async () => resp) };
}

function makeMemory(resumen = ''): any {
  return {
    getMemory: vi.fn(async () => ({ summary: resumen })),
    addInteraction: vi.fn(async () => false),
  };
}

function makeFun(brain = makeBrain(), memory = makeMemory()) {
  return { svc: new FunService(makeConfig(), brain, memory), brain, memory };
}

interface Fixtures {
  jikan?: any;
  nekos?: any;
  fail?: 'all' | 'jikan' | 'nekos';
}

function stubFetch(f: Fixtures): any {
  const mock = vi.fn(async (url: any) => {
    const u = String(url);
    const which = u.includes('jikan') ? 'jikan' : u.includes('nekos.best') ? 'nekos' : '';
    if (f.fail === 'all' || f.fail === which) throw new Error('red caída');
    if (which === 'jikan') return { ok: true, json: async () => f.jikan ?? { data: [] } };
    if (which === 'nekos') return { ok: true, json: async () => f.nekos ?? { results: [] } };
    throw new Error(`fetch inesperado: ${u}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('FunService — handlers', () => {
  beforeEach(limpiarData);
  afterEach(() => vi.unstubAllGlobals());

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
    const { svc } = makeFun();
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
    stubFetch({ jikan: { data: [] } });
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleAnime(i, 'no existe');
    expect(embedOf(i).description).toContain('No encontré');

    stubFetch({ fail: 'jikan' });
    const i2 = makeInteraction();
    await makeFun().svc.handleAnime(i2, 'x');
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
    const { svc } = makeFun();
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
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleTemporada(i);
    const e = embedOf(i);
    expect(e.title).toContain('Temporada fall 2026');
    expect(e.description).toContain('`1.` [Uno](https://mal/1) — ⭐ 8.1');
    expect(e.description).toContain('`2.` [Dos](https://mal/2) — ⭐ —');
  });

  it('/waifu: imagen de nekos.best con crédito de artista; categoría inválida y caída dan error embed', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/waifu.png', artist_name: 'Nana', artist_href: 'http://a/nana' }] } });
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleWaifu(i, 'waifu');
    const e = embedOf(i);
    expect(e.image.url).toBe('http://n/waifu.png');
    expect(e.description).toContain('[Nana](http://a/nana)');

    const i2 = makeInteraction();
    await makeFun().svc.handleWaifu(i2, 'shinobu'); // ya no existe en nekos.best
    expect(embedOf(i2).description).toContain('no existe');

    stubFetch({ fail: 'nekos' });
    const i3 = makeInteraction();
    await makeFun().svc.handleWaifu(i3, 'neko');
    expect(embedOf(i3).description).toContain('nekos.best no respondió');
  });

  it('/accion: con objetivo arma "Autor abraza a <@id>" con gif y crédito del anime', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/hug.gif', anime_name: 'Hoshikuzu Telepath' }] } });
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleAccion(i, 'abrazar', '555');
    const e = embedOf(i);
    expect(e.description).toContain('**Autor** abraza a <@555>');
    expect(e.description).toContain('Hoshikuzu Telepath');
    expect(e.image.url).toBe('http://n/hug.gif');

    const i2 = makeInteraction();
    await makeFun().svc.handleAccion(i2, 'abrazar', null);
    expect(embedOf(i2).description).toContain('reparto abrazos gratis');
  });

  it('/accion: tipo desconocido cae en error embed sin tocar nekos', async () => {
    const mock = stubFetch({ nekos: { results: [{ url: 'http://n/x.gif' }] } });
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleAccion(i, 'noexiste', null);
    expect(embedOf(i).description).toContain('No conozco esa acción');
    expect(mock).not.toHaveBeenCalled();
  });

  it('/ship: % determinista en la descripción, barra consistente y gif de nekos.best', async () => {
    const u1 = user('111', 'Ana');
    const u2 = user('222', 'Beto');
    const pct = shipPercent('111', '222');

    stubFetch({ nekos: { results: [{ url: 'http://n/love.gif', anime_name: 'Nisekoi' }] } });
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleShip(i, u1, u2);
    const e = embedOf(i);
    expect(e.title).toBe('Ana 💕 Beto');
    expect(e.description).toContain(`**${pct}%**`);
    expect(e.description).toContain('❤️'.repeat(Math.round(pct / 10)));
    expect(e.thumbnail.url).toBe('http://av/111');
    expect(e.image.url).toBe('http://n/love.gif');

    // nekos.best caído: el embed sale igual, sólo sin gif (sin lanzar).
    stubFetch({ fail: 'nekos' });
    const i2 = makeInteraction();
    await makeFun().svc.handleShip(i2, u1, u2);
    const e2 = embedOf(i2);
    expect(e2.description).toContain(`**${pct}%**`);
    expect(e2.image).toBeUndefined();

    // Auto-ship: 100% fijo.
    stubFetch({ nekos: { results: [{ url: 'http://n/kiss.gif' }] } });
    const i3 = makeInteraction();
    await makeFun().svc.handleShip(i3, u1, u1);
    expect(embedOf(i3).description).toContain('**100%**');
  });

  it('/uwu: responde el texto transformado; vacío → ephemeral sin transformar', async () => {
    const { svc } = makeFun();
    const i = makeInteraction();
    await svc.handleUwu(i, 'hola mundo');
    expect(i.reply).toHaveBeenCalledWith({ content: 'howa mundo uwu' });

    const i2 = makeInteraction();
    await makeFun().svc.handleUwu(i2, '   ');
    expect(i2.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});

describe('FunService — cache de nekos.best', () => {
  beforeEach(limpiarData);
  afterEach(() => vi.unstubAllGlobals());

  it('segunda llamada a la misma categoría sale del pool sin re-fetch', async () => {
    const mock = stubFetch({ nekos: { results: [{ url: 'http://n/1.png' }, { url: 'http://n/2.png' }] } });
    const { svc } = makeFun();
    await svc.handleWaifu(makeInteraction(), 'waifu');
    await svc.handleWaifu(makeInteraction(), 'waifu');
    const nekosCalls = mock.mock.calls.filter(([u]) => String(u).includes('nekos.best'));
    expect(nekosCalls).toHaveLength(1);
  });

  it('el pool persiste en data/nekos-cache.json y una instancia nueva lo sirve sin red', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/saved.gif' }] } });
    await makeFun().svc.handleWaifu(makeInteraction(), 'neko');
    // Esperar el CONTENIDO (no solo la existencia): la escritura es
    // fire-and-forget y la de un test previo puede aterrizar después del rmSync.
    await vi.waitFor(() => {
      const raw = JSON.parse(readFileSync('data/nekos-cache.json', 'utf8'));
      expect(raw.neko?.[0]?.url).toBe('http://n/saved.gif');
    });

    stubFetch({ fail: 'nekos' });
    const i = makeInteraction();
    await makeFun().svc.handleWaifu(i, 'neko');
    expect(embedOf(i).image.url).toBe('http://n/saved.gif');
  });

  it('TTL 3 días: entrada vencida no se sirve aunque la red caiga; vigente sí', async () => {
    mkdirSync('data', { recursive: true });
    writeFileSync(
      'data/nekos-cache.json',
      JSON.stringify({ neko: [{ url: 'http://n/vieja.png', ts: Date.now() - NEKOS_TTL_MS - 1000 }] }),
    );
    stubFetch({ fail: 'nekos' });
    const i = makeInteraction();
    await makeFun().svc.handleWaifu(i, 'neko');
    expect(embedOf(i).description).toContain('nekos.best no respondió');

    writeFileSync(
      'data/nekos-cache.json',
      JSON.stringify({ neko: [{ url: 'http://n/fresca.png', ts: Date.now() - 1000 }] }),
    );
    const i2 = makeInteraction();
    await makeFun().svc.handleWaifu(i2, 'neko');
    expect(embedOf(i2).image.url).toBe('http://n/fresca.png');
  });
});

describe('FunService — reacción al ser objetivo de /accion', () => {
  beforeEach(limpiarData);
  afterEach(() => vi.unstubAllGlobals());

  it('target = Hakkurin: llama al LLM con el perfil del autor, responde y lo registra en su memoria', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/bite.gif' }] } });
    const brain = makeBrain('jajá, qué valiente');
    const memory = makeMemory('le gustan los mangas');
    const { svc } = makeFun(brain, memory);
    const i = makeInteraction(); // client.user.id = bot1
    await svc.handleAccion(i, 'morder', 'bot1');

    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
    const [prompt, ctxId, userName] = brain.generateResponse.mock.calls[0];
    expect(prompt).toContain('muerde a Hakkurin');
    expect(prompt).toContain('le gustan los mangas');
    expect(ctxId).toBe('u1');
    expect(userName).toBe('Autor');
    expect(i.followUp).toHaveBeenCalledWith({ content: 'jajá, qué valiente' });
    expect(memory.addInteraction).toHaveBeenCalledWith(
      'hakkurin_internal_self',
      expect.stringContaining('/accion morder'),
    );
  });

  it('cooldown de reacción: dos /accion seguidas contra el bot gastan una sola IA', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/bite.gif' }] } });
    const brain = makeBrain('reacción');
    const { svc } = makeFun(brain);
    await svc.handleAccion(makeInteraction(), 'morder', 'bot1');
    await svc.handleAccion(makeInteraction(), 'morder', 'bot1');
    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('LLM sin respuesta → sin followUp, y el embed del gif sale igual', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/bite.gif' }] } });
    const { svc, brain } = makeFun(makeBrain(null));
    const i = makeInteraction();
    await svc.handleAccion(i, 'morder', 'bot1');
    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
    expect(i.followUp).not.toHaveBeenCalled();
    expect(embedOf(i).image.url).toBe('http://n/bite.gif');
  });

  it('target humano → sin reacción del bot', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/bite.gif' }] } });
    const { svc, brain } = makeFun(makeBrain('hola'));
    const i = makeInteraction();
    await svc.handleAccion(i, 'morder', '555');
    expect(brain.generateResponse).not.toHaveBeenCalled();
    expect(i.followUp).not.toHaveBeenCalled();
  });
});
