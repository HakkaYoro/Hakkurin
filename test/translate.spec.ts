import { vi } from 'vitest';
import { AiBrain } from '../src/ai/domain/ports/ai-brain.port';
import { TranslateService } from '../src/discord/application/translate.service';

function makeService(aiAnswer: string | null = 'hello') {
  const brain: any = { generateResponse: vi.fn(async () => aiAnswer) };
  const stats = { bumpAiCall: vi.fn() } as any;
  const config = { get: () => '' } as any; // sin prompt_translate → default
  const svc = new TranslateService(brain as unknown as AiBrain, config, stats);
  return { svc, brain, stats };
}

describe('TranslateService', () => {
  it('shouldTranslate: cada mensaje se traduce una sola vez', () => {
    const { svc } = makeService();
    expect(svc.shouldTranslate('m1')).toBe(true);
    expect(svc.shouldTranslate('m1')).toBe(false);
    expect(svc.shouldTranslate('m2')).toBe(true);
  });

  it('dedupe se vacía al tocar el techo de 500 entradas', () => {
    const { svc } = makeService();
    expect(svc.shouldTranslate('primero')).toBe(true);
    for (let i = 0; i < 500; i++) svc.shouldTranslate(`m${i}`);
    expect(svc.shouldTranslate('primero')).toBe(true); // el techo vació el set
  });

  it('rechaza vacío y >4000 sin gastar IA; 4000 justo pasa', async () => {
    const { svc, brain } = makeService();
    await expect(svc.translate('   ')).resolves.toBeNull();
    await expect(svc.translate('x'.repeat(4001))).resolves.toBeNull();
    expect(brain.generateResponse).not.toHaveBeenCalled();

    await expect(svc.translate('x'.repeat(4000))).resolves.toBe('hello');
    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('traducción exitosa: bumpAiCall("translate") y salida recortada a 1800', async () => {
    const { svc, brain, stats } = makeService('a'.repeat(2000));
    const out = await svc.translate('bonjour le monde');
    expect(out).toHaveLength(1800);
    expect(brain.generateResponse).toHaveBeenCalledTimes(1);
    expect(brain.generateResponse.mock.calls[0][0]).toContain('bonjour le monde');
    expect(stats.bumpAiCall).toHaveBeenCalledWith('translate');
  });

  it('null del brain → null sin registrar stats', async () => {
    const { svc, brain, stats } = makeService(null);
    await expect(svc.translate('hola')).resolves.toBeNull();
    expect(stats.bumpAiCall).not.toHaveBeenCalled();
  });
});
