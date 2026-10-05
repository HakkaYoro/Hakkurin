import { vi } from 'vitest';
import { LogTeeService } from '../src/web/infrastructure/log-tee.service';

// Ring buffer del tee de logs: captura nivel/contexto y conserva las últimas
// 2000 líneas. Se stubbea process.stdout para no ensuciar la salida del test
// (ConsoleLogger imprime por ahí).

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => vi.restoreAllMocks());

it('captura línea con timestamp, nivel y contexto', () => {
  const t = new LogTeeService();
  t.log('hola mundo', 'SidecarClient');
  t.warn('cuidado');
  t.error('boom');
  const out = t.text();
  expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m); // timestamp ISO
  expect(out).toContain('LOG [SidecarClient] hola mundo');
  expect(out).toContain('WARN cuidado');
  expect(out).toContain('ERROR boom');
});

it('ring buffer: conserva las últimas 2000 líneas', () => {
  const t = new LogTeeService();
  for (let i = 0; i < 2100; i++) t.log(`línea ${i}`);
  const lines = t.text().trimEnd().split('\n');
  expect(lines).toHaveLength(2000);
  expect(lines[0]).toContain('línea 100'); // las 100 más viejas se descartaron
  expect(lines[1999]).toContain('línea 2099');
});
