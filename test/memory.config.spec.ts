import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '../src/common/config.service';
import { CryptoAdapter } from '../src/memory/infrastructure/persistence/crypto.adapter';
import { MemoryRepositoryAdapter } from '../src/memory/infrastructure/persistence/memory-repository.adapter';
import { MemoryQueueAdapter } from '../src/memory/infrastructure/persistence/memory-queue.adapter';
import { MemoryService, BOT_SELF_ID } from '../src/memory/application/memory.service';

describe('CryptoAdapter', () => {
  let c: CryptoAdapter;
  beforeEach(async () => {
    c = new CryptoAdapter();
    await (c as any).onModuleInit();
  });

  it('cifra y descifra round-trip', () => {
    const original = 'hola míster ☕ — { "json": true }';
    expect(c.decrypt(c.encrypt(original))).toBe(original);
  });

  it('falla ante un ciphertext alterado (auth tag)', () => {
    const ct = c.encrypt('secreto');
    // XOR sobre un byte del authTag (bytes 12-27) — garantiza cambio y falla la verificación.
    const tampered = Buffer.from(ct);
    tampered[12] ^= 0xff;
    expect(() => c.decrypt(tampered)).toThrow();
  });
});

describe('ConfigService', () => {
  it('escribe defaults si no existe y sobrevive a recarga', async () => {
    const a = new ConfigService();
    await a['load']();
    expect(a.get('bot_name')).toBe('Hakkurin');
    expect(a.get('reply_probability')).toBe(0.125);
    await a.set('bot_name', 'TestBot');
    const b = new ConfigService();
    await b['load']();
    expect(b.get('bot_name')).toBe('TestBot');
  });
});

describe('MemoryService', () => {
  let mem: MemoryService;
  let cryptoSvc: CryptoAdapter;
  let repo: MemoryRepositoryAdapter;
  beforeEach(async () => {
    cryptoSvc = new CryptoAdapter();
    repo = new MemoryRepositoryAdapter(cryptoSvc);
    mem = new MemoryService(cryptoSvc, repo, new MemoryQueueAdapter(), new EventEmitter2());
    await cryptoSvc.onModuleInit();
    await mem.onModuleInit();
  });

  it('devuelve memoria vacía para usuario nuevo', async () => {
    const m = await mem.getMemory('999');
    expect(m.interaction_count).toBe(0);
    expect(m.history_buffer).toEqual([]);
    expect(m.notes).toBe('Usuario nuevo.');
  });

  it('addInteraction persiste y devuelve shouldSummarize al pasar el umbral de cuenta', async () => {
    // Fija last_summary_time al ahora para aislar el umbral de CUENTA (20);
    // con last_summary_time=0 la primera interacción ya dispararía por tiempo.
    await mem.saveMemory('1', { notes: '', last_summary_time: Date.now() / 1000 } as any);
    for (let i = 0; i < 19; i++) await expect(mem.addInteraction('1', `msg ${i}`)).resolves.toBe(false);
    await expect(mem.addInteraction('1', 'msg 20')).resolves.toBe(true);
    const m = await mem.getMemory('1');
    expect(m.interaction_count).toBe(20);
  });

  it('normaliza esquemas legacy/corruptos', async () => {
    const bad = {
      profile: { personality_traits: 'no es lista', likes: [1, 2, null, 'x'] },
      interaction_count: 'cinco',
      last_channel_id: '123abc',
    };
    await (repo as any).atomicWriteBytes((repo as any).filePath('2'), cryptoSvc.encrypt(JSON.stringify(bad)));
    const m = await mem.getMemory('2');
    expect(m.profile.personality_traits).toEqual([]);
    expect(m.profile.likes).toEqual(['1', '2', 'x']);
    expect(m.interaction_count).toBe(0);
    expect(m.last_channel_id).toBeNull();
  });

  it('cola: dedupe inmediata + processQueue promueve >5min', async () => {
    await mem.addToQueue('3', 'dup');
    await mem.addToQueue('3', 'dup'); // dedupe dentro de 10s → 1 sola entrada
    expect(await mem.getQueuedInteractions('3')).toEqual(['dup']);

    // forzamos timestamp viejo escribiendo la cola a mano
    await fsPromises.mkdir(path.dirname('data/memory/queue.json'), { recursive: true });
    await fsPromises.writeFile('data/memory/queue.json', JSON.stringify([{ user_id: '3', text: 'viejo', timestamp: 0 }]));

    const promoted = await mem.processQueue();
    expect(promoted).toEqual(['3']); // >300s → promovido y trigger
    expect(await mem.getQueuedInteractions('3')).toEqual([]);
  });

  it('self-memory: logSelfAction + getSelfMemory', async () => {
    await mem.logSelfAction('probé algo');
    // todavía no hay summary (solo buffer)
    expect(await mem.getSelfMemory()).toBe('Sin memoria interna previa.');
    await mem.updateSummary(BOT_SELF_ID, 'hoy probé algo', ['[YO DIJE/HICE]: probé algo']);
    expect(await mem.getSelfMemory()).toBe('hoy probé algo');
  });

  it('addInteraction con texto null/vacío → false y no persiste nada', async () => {
    expect(await mem.addInteraction('20', null as any)).toBe(false);
    expect(await mem.addInteraction('20', '   ')).toBe(false);
    const m = await mem.getMemory('20');
    expect(m.interaction_count).toBe(0);
  });

  it('updateSummary: prefijo procesado recorta el buffer; prefijo ajeno lo conserva; null lo vacía', async () => {
    for (const t of ['a', 'b', 'c']) await mem.addInteraction('21', t);

    // Prefijo que coincide → recorta esas entradas.
    await mem.updateSummary('21', 'resumen v1', ['a', 'b']);
    expect((await mem.getBufferAndSummary('21')).buffer).toEqual(['c']);
    expect((await mem.getBufferAndSummary('21')).summary).toBe('resumen v1');

    // Prefijo que NO coincide → conserva el buffer completo (no pierde datos).
    await mem.updateSummary('21', 'resumen v2', ['z']);
    expect((await mem.getBufferAndSummary('21')).buffer).toEqual(['c']);

    // processedInteractions null → vacía el buffer.
    await mem.updateSummary('21', 'resumen v3', null);
    expect((await mem.getBufferAndSummary('21')).buffer).toEqual([]);

    // updateSummary también escribe el espejo plano para el WebUI.
    const txt = await fsPromises.readFile('data/memory/summaries/21.txt', 'utf-8');
    expect(txt).toBe('resumen v3');
  });

  it('checkStaleBuffers y getUsersWithPendingBuffer listan solo buffers con contenido', async () => {
    await mem.addInteraction('5', 'hola'); // last_summary_time=0 → stale
    await mem.saveMemory('6', { history_buffer: [], last_summary_time: 0 } as any); // sin buffer
    const stale = await mem.checkStaleBuffers();
    expect(stale).toContain('5');
    expect(stale).not.toContain('6');
    const pending = await mem.getUsersWithPendingBuffer();
    expect(pending).toContain('5');
    expect(pending).not.toContain('6');
  });

  it('getMemorySummary compone notas + resumen + cola pendiente + perfil', async () => {
    await mem.saveMemory('7', {
      profile: { name: 'Ana', likes: ['anime', 'café'], speaking_style: '' },
      notes: 'le gusta molestar',
      summary: 'RESUMEN LARGO',
    } as any);
    await mem.addToQueue('7', 'mensaje en cola');
    const s = await mem.getMemorySummary('7');
    expect(s).toContain('Notas Básicas: le gusta molestar');
    expect(s).toContain('RESUMEN DETALLADO A LARGO PLAZO:\nRESUMEN LARGO');
    expect(s).toContain('MEMORIA RECIENTE (No procesada):\nmensaje en cola');
    expect(s).toContain('Nombre: Ana');
    expect(s).toContain('Gustos: anime, café');
  });

  it('updateLastChannel: entero persiste, basura → null', async () => {
    await mem.updateLastChannel('8', '12345');
    expect((await mem.getMemory('8')).last_channel_id).toBe(12345);
    await mem.updateLastChannel('8', 'no-soy-numero');
    expect((await mem.getMemory('8')).last_channel_id).toBeNull();
  });

  it('getAllUsersData devuelve user_id + last_channel + summary por usuario', async () => {
    await mem.updateLastChannel('9', 555);
    const all = await mem.getAllUsersData();
    const u9 = all.find((u) => u.user_id === '9');
    expect(u9?.last_channel_id).toBe(555);
    expect(typeof u9?.summary).toBe('string');
  });

  it('listMemories: marca is_self y ordena por mtime desc', async () => {
    await mem.saveMemory('a', {} as any);
    await mem.saveMemory('b', {} as any);
    // mtimes deterministas: b más reciente que a
    const base = new Date('2026-01-01T00:00:00Z');
    await fsPromises.utimes((repo as any).filePath('a'), base, base);
    const later = new Date('2026-01-02T00:00:00Z');
    await fsPromises.utimes((repo as any).filePath('b'), later, later);
    const list = await mem.listMemories();
    const ids = list.map((l) => l.user_id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
    const selfRow = list.find((l) => l.user_id === BOT_SELF_ID);
    if (selfRow) expect(selfRow.is_self).toBe(true);
    expect(list.find((l) => l.user_id === 'a')!.is_self).toBe(false);
    // formato de fecha legible
    expect(list[0].date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('getMemory con archivo corrupto: lo borra (.enc + .txt) y devuelve memoria vacía', async () => {
    const encPath = (repo as any).filePath('10');
    await fsPromises.mkdir('data/memory/summaries', { recursive: true });
    await fsPromises.writeFile(encPath, Buffer.from('no-es-cifrado'));
    await fsPromises.writeFile('data/memory/summaries/10.txt', 'viejo');
    const m = await mem.getMemory('10');
    expect(m.interaction_count).toBe(0); // vacía
    await expect(fsPromises.access(encPath)).rejects.toThrow(); // .enc eliminado
    await expect(fsPromises.access('data/memory/summaries/10.txt')).rejects.toThrow();
  });

  it('mutex: encolados concurrentes no pierden items', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `msg ${i}`);
    await Promise.all(texts.map((t) => mem.addToQueue('mx', t)));
    expect(await mem.getQueuedInteractions('mx')).toEqual(texts);
  });

  it('addToQueue ignora null/vacío; getQueuedInteractions filtra por usuario', async () => {
    await mem.addToQueue('11', null as any);
    await mem.addToQueue('11', '  ');
    await mem.addToQueue('', 'x');
    expect(await mem.getQueuedInteractions('11')).toEqual([]);
    await mem.addToQueue('11', 'para mí');
    await mem.addToQueue('12', 'para otro');
    expect(await mem.getQueuedInteractions('11')).toEqual(['para mí']);
    expect(await mem.getQueuedInteractions('12')).toEqual(['para otro']);
  });

  it('deleteMemory borra .enc y .txt; deleteAllMemories vacía todo', async () => {
    await mem.saveMemory('13', { summary: 'con espejo' } as any);
    await mem.saveMemory('14', {} as any);
    await mem.deleteMemory('13');
    await expect(fsPromises.access((repo as any).filePath('13'))).rejects.toThrow();
    await expect(fsPromises.access('data/memory/summaries/13.txt')).rejects.toThrow();
    expect((await mem.getMemory('13')).summary).toBe('');

    await mem.deleteAllMemories();
    await expect(fsPromises.access((repo as any).filePath('14'))).rejects.toThrow();
    expect((await mem.listMemories()).length).toBe(0);
  });
});
