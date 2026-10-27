import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCIONES,
  nekosCredit,
  nekosPick,
  shipPercent,
  shipTags,
  SHIP_TIERS,
  uwuify,
  WAIFU_CATEGORIES,
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

  it('nekosPick elige un resultado con url y devuelve null sin resultados', () => {
    const results = [{ url: 'http://n/1.gif' }, { url: 'http://n/2.gif' }];
    for (let i = 0; i < 20; i++) {
      const hit = nekosPick({ results });
      expect(hit!.url).toMatch(/^http:\/\/n\//);
    }
    expect(nekosPick({ results: [] })).toBeNull();
    expect(nekosPick({})).toBeNull();
    expect(nekosPick({ results: [{ sin: 'url' }] })).toBeNull();
  });

  it('nekosCredit acredita al anime (gif) o al artista (imagen), vacío si no hay', () => {
    expect(nekosCredit({ url: 'u', anime_name: 'Hoshikuzu Telepath' })).toContain('Hoshikuzu Telepath');
    expect(nekosCredit({ url: 'u', artist_name: 'Nana', artist_href: 'http://a/nana' })).toContain('[Nana](http://a/nana)');
    expect(nekosCredit({ url: 'u', artist_name: 'Nana' })).toContain('Nana');
    expect(nekosCredit({ url: 'u' })).toBe('');
  });

  it('las 7 acciones apuntan a categorías gif existentes en nekos.best', () => {
    expect(Object.keys(ACCIONES)).toHaveLength(7);
    for (const a of Object.values(ACCIONES)) expect(a.cat).toBeTruthy();
  });
});

// Handlers: fetch global stubbeado por dominio; aserciones sobre el embed que
// llega a editReply (mismo estilo que los tests de music-ui).

function makeConfig(): any {
  return { get: (k: string, d?: any) => (k === 'bot_name' ? 'Hakkurin' : d ?? '') };
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
    stubFetch({ jikan: { data: [] } });
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleAnime(i, 'no existe');
    expect(embedOf(i).description).toContain('No encontré');

    stubFetch({ fail: 'jikan' });
    const i2 = makeInteraction();
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

  it('/waifu: imagen de nekos.best con crédito de artista; categoría inválida y caída dan error embed', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/waifu.png', artist_name: 'Nana', artist_href: 'http://a/nana' }] } });
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleWaifu(i, 'waifu');
    const e = embedOf(i);
    expect(e.image.url).toBe('http://n/waifu.png');
    expect(e.description).toContain('[Nana](http://a/nana)');

    const i2 = makeInteraction();
    await svc.handleWaifu(i2, 'shinobu'); // ya no existe en nekos.best
    expect(embedOf(i2).description).toContain('no existe');

    stubFetch({ fail: 'nekos' });
    const i3 = makeInteraction();
    await svc.handleWaifu(i3, 'neko');
    expect(embedOf(i3).description).toContain('nekos.best no respondió');
  });

  it('/accion: con objetivo arma "Autor abraza a <@id>" con gif y crédito del anime', async () => {
    stubFetch({ nekos: { results: [{ url: 'http://n/hug.gif', anime_name: 'Hoshikuzu Telepath' }] } });
    const svc = new FunService(makeConfig());
    const i = makeInteraction();
    await svc.handleAccion(i, 'abrazar', '555');
    const e = embedOf(i);
    expect(e.description).toContain('**Autor** abraza a <@555>');
    expect(e.description).toContain('Hoshikuzu Telepath');
    expect(e.image.url).toBe('http://n/hug.gif');

    const i2 = makeInteraction();
    await svc.handleAccion(i2, 'abrazar', null);
    expect(embedOf(i2).description).toContain('reparto abrazos gratis');
  });

  it('/ship: % determinista en la descripción, barra consistente y gif de nekos.best', async () => {
    const u1 = user('111', 'Ana');
    const u2 = user('222', 'Beto');
    const pct = shipPercent('111', '222');

    stubFetch({ nekos: { results: [{ url: 'http://n/love.gif', anime_name: 'Nisekoi' }] } });
    const svc = new FunService(makeConfig());
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
    await svc.handleShip(i2, u1, u2);
    const e2 = embedOf(i2);
    expect(e2.description).toContain(`**${pct}%**`);
    expect(e2.image).toBeUndefined();

    // Auto-ship: 100% fijo.
    stubFetch({ nekos: { results: [{ url: 'http://n/kiss.gif' }] } });
    const i3 = makeInteraction();
    await svc.handleShip(i3, u1, u1);
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

