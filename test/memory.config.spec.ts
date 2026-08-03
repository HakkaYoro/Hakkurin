import { ConfigService } from '../src/common/config.service';
import { CryptoService } from '../src/memory/crypto.service';
import { MemoryService, BOT_SELF_ID } from '../src/memory/memory.service';

// Round-trip de cifrado AES-256-GCM (CryptoService).
describe('CryptoService', () => {
  let c: CryptoService;
  beforeEach(async () => {
    c = new CryptoService();
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

// ConfigService: defaults + escritura atómica persistente.
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

// MemoryService: puerto de memory_manager.py.
describe('MemoryService', () => {
  let mem: MemoryService;
  beforeEach(async () => {
    mem = new MemoryService(new CryptoService());
    await (mem as any).crypto.onModuleInit();
    await (mem as any).onModuleInit();
  });

  it('devuelve memoria vacía para usuario nuevo', async () => {
    const m = await mem.getMemory('999');
    expect(m.interaction_count).toBe(0);
    expect(m.history_buffer).toEqual([]);
    expect(m.notes).toBe('Usuario nuevo.');
  });

  it('addInteraction persiste y devuelve shouldSummarize al pasar el umbral de cuenta', async () => {
    // Fija last_summary_time al ahora para aislar el umbral de CUENTA (20).
    // (fiel a Python: con last_summary_time=0, la primera interacción ya trigger
    //  por timeSinceLast enorme — ese camino se prueba en self-memory abajo.)
    await mem.saveMemory('1', { notes: '', last_summary_time: Date.now() / 1000 } as any);
    for (let i = 0; i < 19; i++) await expect(mem.addInteraction('1', `msg ${i}`)).resolves.toBe(false);
    await expect(mem.addInteraction('1', 'msg 20')).resolves.toBe(true);
    const m = await mem.getMemory('1');
    expect(m.interaction_count).toBe(20);
  });

  it('normaliza esquemas legacy/corruptos', async () => {
    const cryptoSvc = (mem as any).crypto;
    const bad = {
      profile: { personality_traits: 'no es lista', likes: [1, 2, null, 'x'] },
      interaction_count: 'cinco',
      last_channel_id: '123abc',
    };
    await (mem as any).atomicWriteBytes((mem as any).filePath('2'), cryptoSvc.encrypt(JSON.stringify(bad)));
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
    const fs = require('fs').promises;
    const path = require('path');
    await fs.mkdir(path.dirname('data/memory/queue.json'), { recursive: true });
    await fs.writeFile('data/memory/queue.json', JSON.stringify([{ user_id: '3', text: 'viejo', timestamp: 0 }]));

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
});
