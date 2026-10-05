import { SlashCommandsService } from '../src/discord/infrastructure/slash-commands.service';
import { MusicUiService } from '../src/discord/infrastructure/music-ui.service';

// Registro + ruteo de slash commands y la vista de búsqueda de Navidrome
// (snapshots por messageId + botones song_/album_/artist_).

function makeFakes(over: Record<string, any> = {}) {
  const music = {
    play: vi.fn(async () => {}),
    skip: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    queueInfo: vi.fn(async () => {}),
    songToItem: vi.fn((song: any) => ({ type: 'navidrome', url: `stream:${song.id}`, id: song.id, title: song.title })),
    startRadioMode: vi.fn(),
    joinFromButton: vi.fn(async () => true),
    enqueueAndPlay: vi.fn(async () => {}),
    ...over.music,
  } as any;
  const navidrome = {
    search: vi.fn(async () => ({})),
    getAlbumSongs: vi.fn(async () => []),
    getArtistRadio: vi.fn(async () => []),
    getCoverUrl: vi.fn((id?: string) => (id ? `http://cover/${id}` : null)),
    ...over.navidrome,
  } as any;
  const musicUi = new MusicUiService(music, navidrome);
  const svc = new SlashCommandsService(music, musicUi);
  return { svc, music, navidrome, musicUi };
}

function chatInteraction(over: Record<string, any> = {}) {
  const i: any = {
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    commandName: 'play',
    options: { getString: vi.fn(() => 'https://youtu.be/x') },
    deferred: false,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => ({ id: 'msg-1' })),
    reply: vi.fn(async () => {}),
    ...over,
  };
  return i;
}

describe('SlashCommandsService — registro y ruteo', () => {
  it('register publica los 6 comandos globalmente', async () => {
    const { svc } = makeFakes();
    const set = vi.fn(async (_cmds: any[]) => {});
    await svc.register({ application: { commands: { set } } } as any);
    expect(set).toHaveBeenCalledTimes(1);
    const names = set.mock.calls[0][0].map((c: any) => c.name);
    expect(names).toEqual(['play', 'skip', 'stop', 'queue', 'search', 'radio']);
  });

  it('register sin fallos aunque la API rechace', async () => {
    const { svc } = makeFakes();
    const set = vi.fn(async (_cmds: any[]) => { throw new Error('discord down'); });
    await expect(svc.register({ application: { commands: { set } } } as any)).resolves.toBeUndefined();
  });

  it.each([
    ['play', 'play', ['https://youtu.be/x']],
    ['skip', 'skip', []],
    ['stop', 'stop', []],
    ['queue', 'queueInfo', []],
  ])('%s rutea al método de música correspondiente', async (_n, method, args) => {
    const { svc, music } = makeFakes();
    const i = chatInteraction({ commandName: _n });
    await svc.handle(i);
    expect((music as any)[method]).toHaveBeenCalledWith(i, ...args);
  });

  it('search y radio van a handleSearch (defer + búsqueda en Navidrome)', async () => {
    const { svc, navidrome } = makeFakes();
    const opts = { getString: vi.fn(() => 'metal') };
    await svc.handle(chatInteraction({ commandName: 'search', options: opts }));
    await svc.handle(chatInteraction({ commandName: 'radio', options: opts }));
    expect(navidrome.search).toHaveBeenCalledTimes(2);
    expect(navidrome.search).toHaveBeenCalledWith('metal', 5);
  });

  it('componentes van a handleButton; el rechazo del handler sube a bindEvents (.catch)', async () => {
    const { svc, music } = makeFakes();
    music.play.mockRejectedValueOnce(new Error('boom'));
    // handleCommand devuelve la promesa rechazada sin try/catch — bindEvents la captura.
    await expect(svc.handle(chatInteraction())).rejects.toThrow('boom');
    const btn = {
      isChatInputCommand: () => false,
      isMessageComponent: () => true,
      customId: 'song_0',
      message: { id: 'desconocido' },
      reply: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
    } as any;
    await svc.handle(btn);
    expect(btn.reply).toHaveBeenCalledWith({ content: expect.stringContaining('expiró'), ephemeral: true });
  });
});

describe('SlashCommandsService — vista de búsqueda', () => {
  function makeChat(deferred = false) {
    return {
      isChatInputCommand: () => true,
      isMessageComponent: () => false,
      commandName: 'search',
      options: { getString: vi.fn(() => 'metal') },
      deferred,
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async () => ({ id: 'msg-1' })),
      reply: vi.fn(async () => {}),
    } as any;
  }

  it('resultados: editReply con embed numerado + filas de botones y snapshot guardado', async () => {
    const { musicUi, navidrome } = makeFakes({
      navidrome: {
        search: vi.fn(async () => ({ song: [{ id: 's1', title: 'Track A', artist: 'Band', coverArt: 'cv1' }] })),
      },
    });
    const i = makeChat();
    (musicUi as any).handleSearch(i, 'metal', false);
    await vi.waitFor(() => expect(i.editReply).toHaveBeenCalled());
    expect(navidrome.search).toHaveBeenCalledWith('metal', 5);
    const arg = i.editReply.mock.calls[0][0];
    expect(arg.content).toBeUndefined();
    const embed = arg.embeds[0].data;
    expect(embed.title).toBe('🔍 Resultados de Navidrome: metal');
    expect(embed.description).toContain('**🎵 Canciones**');
    expect(embed.description).toContain('`1.` Track A - Band');
    expect(embed.color).toBe(0x3498db);
    expect(embed.footer).toEqual({ text: 'Hakkurei Music' });
    expect(embed.thumbnail).toEqual({ url: 'http://cover/cv1' });
    expect(arg.components).toHaveLength(1); // solo fila de songs
    // Snapshot: el botón del mensaje funciona (lo prueba el test de abajo).
  });

  it('sin resultados: MISMO embed con "No se encontraron resultados." y SIN botones', async () => {
    const { musicUi } = makeFakes();
    const i = makeChat();
    (musicUi as any).handleSearch(i, 'nada', true);
    await vi.waitFor(() => expect(i.editReply).toHaveBeenCalled());
    const arg = i.editReply.mock.calls[0][0];
    const embed = arg.embeds[0].data;
    expect(embed.title).toBe('📻 Radio: nada');
    expect(embed.description).toBe('No se encontraron resultados.');
    expect(embed.color).toBe(0x3498db);
    expect(embed.footer).toEqual({ text: 'Hakkurei Music' });
    expect(embed.thumbnail).toBeUndefined(); // sin coverArt no hay thumbnail
    expect(arg.components).toBeUndefined(); // sin resultados: sin botones
  });

  it('botón song: songToItem + joinFromButton + enqueueAndPlay + confirmación', async () => {
    const { svc, music, musicUi } = makeFakes({
      navidrome: {
        search: vi.fn(async () => ({ song: [{ id: 's1', title: 'Track A', artist: 'Band' }] })),
        getAlbumSongs: vi.fn(async () => [{ id: 'a1', title: 'Album Track' }]),
        getArtistRadio: vi.fn(async () => [{ id: 'r1', title: 'Radio Track' }]),
      },
    });
    // Crear snapshot vía búsqueda.
    const search = makeChat();
    (musicUi as any).handleSearch(search, 'metal', false);
    await vi.waitFor(() => expect(search.editReply).toHaveBeenCalled());

    const btn = {
      isChatInputCommand: () => false,
      isMessageComponent: () => true,
      customId: 'song_0',
      message: { id: 'msg-1' },
      guildId: 'g1',
      guild: { id: 'g1' },
      member: { id: 'u1' },
      channel: { id: 'c1' },
      user: { id: 'u1' },
      deferUpdate: vi.fn(async () => {}),
      editReply: vi.fn(async () => {}),
    } as any;
    await svc.handle(btn);
    expect(music.songToItem).toHaveBeenCalledWith({ id: 's1', title: 'Track A', artist: 'Band' });
    expect(music.joinFromButton).toHaveBeenCalledWith(btn.guild, btn.member);
    expect(music.enqueueAndPlay).toHaveBeenCalledWith(btn.guild, btn.channel, [expect.objectContaining({ id: 's1' })]);
    expect(btn.editReply).toHaveBeenCalledWith({ content: '✅ 1 añadida(s) a la cola.', components: [] });
  });

  it('botón album y artist expanden canciones; radio activa modo radio', async () => {
    const { svc, music, musicUi, navidrome } = makeFakes({
      navidrome: {
        search: vi.fn(async () => ({
          album: [{ id: 'al1', name: 'Disco' }],
          artist: [{ id: 'ar1', name: 'Banda' }],
        })),
        getAlbumSongs: vi.fn(async () => [{ id: 'a1', title: 'T1' }, { id: 'a2', title: 'T2' }]),
        getArtistRadio: vi.fn(async () => [{ id: 'r1', title: 'R1' }]),
      },
    });
    const search = makeChat();
    (musicUi as any).handleSearch(search, 'metal', true); // isRadio
    await vi.waitFor(() => expect(search.editReply).toHaveBeenCalled());

    const albumBtn = {
      isChatInputCommand: () => false, isMessageComponent: () => true, customId: 'album_0',
      message: { id: 'msg-1' }, guildId: 'g1', guild: { id: 'g1' }, member: { id: 'u1' }, channel: { id: 'c1' },
      deferUpdate: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    } as any;
    await svc.handle(albumBtn);
    expect(navidrome.getAlbumSongs).toHaveBeenCalledWith('al1');
    expect(music.enqueueAndPlay).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), [expect.objectContaining({ id: 'a1' }), expect.objectContaining({ id: 'a2' })],
    );

    // Mismo snapshot, ahora el botón de artista con isRadio.
    const artistBtn = {
      isChatInputCommand: () => false, isMessageComponent: () => true, customId: 'artist_0',
      message: { id: 'msg-1' }, guildId: 'g1', guild: { id: 'g1' }, member: { id: 'u1' }, channel: { id: 'c1' },
      deferUpdate: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    } as any;
    await svc.handle(artistBtn);
    expect(navidrome.getArtistRadio).toHaveBeenCalledWith('Banda', 20);
    expect(music.startRadioMode).toHaveBeenCalledWith('g1');
    expect(music.enqueueAndPlay).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), [expect.objectContaining({ id: 'r1' })],
    );
  });

  it('botón con usuario fuera de VC → mensaje y sin encolar', async () => {
    const { svc, music, musicUi } = makeFakes({
      navidrome: { search: vi.fn(async () => ({ song: [{ id: 's1', title: 'T', artist: 'A' }] })) },
      music: {
        songToItem: vi.fn(() => ({ type: 'navidrome', url: 'x', id: 's1' })),
        joinFromButton: vi.fn(async () => false),
      },
    });
    const search = makeChat();
    (musicUi as any).handleSearch(search, 'metal', false);
    await vi.waitFor(() => expect(search.editReply).toHaveBeenCalled());
    const btn = {
      isChatInputCommand: () => false, isMessageComponent: () => true, customId: 'song_0',
      message: { id: 'msg-1' }, guildId: 'g1', guild: { id: 'g1' }, member: { id: 'u1' }, channel: { id: 'c1' },
      deferUpdate: vi.fn(async () => {}), editReply: vi.fn(async () => {}),
    } as any;
    await svc.handle(btn);
    expect(btn.editReply).toHaveBeenCalledWith({ content: '¡Necesitas estar en un canal de voz!', components: [] });
    expect(music.enqueueAndPlay).not.toHaveBeenCalled();
  });
});
