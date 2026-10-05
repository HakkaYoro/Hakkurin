import { rename, writeFile } from 'fs/promises';

// Wrapper propio y no timers/promises: los fake timers de vitest controlan el
// setTimeout global, no el scheduler interno de timers/promises.
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function toArray<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Sleep abortable: rechaza con `abortValue` si la señal ya venía abortada o se
 * aborta durante la espera. El llamador elige el valor y compara contra SU
 * símbolo (p.ej. ABORTED del servicio que invoca).
 */
export function sleepMs(ms: number, signal: AbortSignal, abortValue: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortValue);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortValue);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** GMT-4 fijo (sin DST): desplaza y lee con getters UTC para no depender del TZ del host. */
export function gmt4Date(d: Date): Date {
  return new Date(d.getTime() + -4 * 60 * 60_000);
}

/** Escritura atómica (tmp + rename): evita JSON truncado si el proceso muere a mitad. */
export async function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

/** Slice del primer bloque balanceado open…close desde `from`, respetando
 *  strings con escapes. null si nunca cierra. */
export function balancedSlice(text: string, open: string, close: string, from = 0): string | null {
  const start = text.indexOf(open, from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
