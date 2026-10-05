/** Contexto extraído de la primera URL de un texto. */
export interface UrlContext {
  text: string | null;
  thumbnailData: Buffer | null;
  thumbnailMime: string | null;
}

export abstract class UrlEnricherPort {
  abstract enrich(userText: string): Promise<UrlContext>;
}
