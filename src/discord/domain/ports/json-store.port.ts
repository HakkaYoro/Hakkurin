/** Dedupe de celebraciones: claves tipo "xmas_2026" → ya celebrado. */
export abstract class HolidayStorePort {
  abstract load(): Promise<Record<string, boolean>>;
  abstract save(data: Record<string, boolean>): Promise<void>;
}

export interface StatusMessages {
  tired?: string[];
  recovery?: string[];
}

export abstract class SleepStorePort {
  /** {} si el archivo falta o el JSON es inválido → frases por defecto. */
  abstract loadStatusMessages(): Promise<StatusMessages>;
}
