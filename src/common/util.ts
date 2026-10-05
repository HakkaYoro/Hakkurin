// Utilerías compartidas. Fuente única para lo que estaba duplicado entre
// navidrome/gemini (shuffle), slash-commands/navidrome (toArray),
// discord/music (delay) y conversation/sleep (nowSec).

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

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Sleep abortable (venía de DiscordService): rechaza con `abortValue` si la señal
 * ya venía abortada o se aborta durante la espera. El valor de aborto lo pasa el
 * llamador (cada módulo compara contra SU símbolo, p.ej. ABORTED de SmartResponseService).
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

/** Escritura atómica de texto (tmp + rename) — evita JSON truncado al morir a mitad. */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const { writeFile, rename } = await import('fs/promises');
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, filePath);
}
