import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { ConfigService } from '../src/common/config.service';

// Comportamiento de ConfigService: defaults, persistencia atómica y lectura.
// El cwd es un tmp aislado (test/_setup.ts), así que data/config.json es seguro.

it('defaults: get devuelve el valor por defecto y getAll el objeto completo', async () => {
  const c = new ConfigService();
  await c.load();
  expect(c.get('bot_name')).toBe('Hakkurin');
  expect(c.get('reply_probability')).toBe(0.125);
  expect(c.get('inexistente', 'fallback')).toBe('fallback');
  expect(c.getAll().allowed_channels).toEqual([]);
});

it('set persiste en disco y una instancia nueva lo lee de vuelta', async () => {
  const c = new ConfigService();
  await c.load();
  await c.set('bot_name', 'Otro');
  await c.set('reply_probability', 0.5);

  const c2 = new ConfigService();
  await c2.load();
  expect(c2.get('bot_name')).toBe('Otro');
  expect(c2.get('reply_probability')).toBe(0.5);
});

it('save es atómico: no deja .tmp residual y escribe JSON legible', async () => {
  const c = new ConfigService();
  await c.load();
  await c.set('debug_dm', true);
  expect(existsSync('data/config.json')).toBe(true);
  expect(existsSync('data/config.json.tmp')).toBe(false);
  const raw = JSON.parse(await fs.readFile('data/config.json', 'utf-8'));
  expect(raw.debug_dm).toBe(true);
});

it('load con JSON corrupto no lanza y mantiene defaults (no pisa el archivo)', async () => {
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/config.json', '{ no es json !!!');
  const c = new ConfigService();
  await c.load();
  expect(c.get('bot_name')).toBe('Hakkurin');
  // El archivo corrupto queda intacto (no se sobreescribe con defaults).
  expect(await fs.readFile('data/config.json', 'utf-8')).toBe('{ no es json !!!');
});
