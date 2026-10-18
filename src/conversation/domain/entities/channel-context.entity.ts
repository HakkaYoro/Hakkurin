import { nowSec } from '../../../common/util';

export const HISTORY_WINDOW_S = 3600; // 1h
export const HISTORY_MAX = 50;
export const IMAGE_WINDOW_S = 300; // 5 min
export const IMAGE_SPAM_WINDOW_S = 120;
export const IMAGE_SPAM_BURST_COUNT = 4;
export const IMAGE_SPAM_BURST_WINDOW_S = 60;
export const SEEN_IMAGES_MAX = 50;
// ponytail: límite de RAM de recentImages; con el cap el worst case es acotado
// y no hace falta ajustarlo por uso.
const RECENT_IMAGES_MAX = 20;

export interface StoredMessage {
  ts: number;
  content: string;
  author: string;
  authorId: string;
}

export interface StoredImage {
  ts: number;
  data: Buffer;
  mime: string;
}

export interface SeenImage {
  ts: number;
  url: string;
  authorId: string;
}

export class ChannelContext {
  messages: StoredMessage[] = [];
  recentImages: StoredImage[] = [];
  seenImages: SeenImage[] = [];
  lastBotActivity = 0;

  addMessage(authorName: string, authorId: string, content: string): void {
    const now = nowSec();
    this.messages.push({ ts: now, content, author: authorName, authorId });
    this.cleanup(now);
  }

  addImage(data: Buffer, mime: string): void {
    const now = nowSec();
    this.recentImages.push({ ts: now, data, mime });
    this.cleanup(now);
  }

  /** Registra la imagen ANTES de que smart-response evalúe spam: la actual cuenta incluida. */
  noteImage(url: string, authorId: string): void {
    const now = nowSec();
    this.seenImages.push({ ts: now, url, authorId });
    this.cleanup(now);
  }

  assessImageSpam(
    url: string,
    authorId: string,
    now = nowSec(),
  ): { repeated: boolean; burst: boolean; burstCount: number } {
    // La actual ya está registrada (noteImage corre antes): repeated exige OTRA
    // entrada previa con la misma url del mismo autor.
    const repeats = this.seenImages.filter(
      (s) => s.url === url && s.authorId === authorId && now - s.ts < IMAGE_SPAM_WINDOW_S,
    ).length;
    const burstCount = this.seenImages.filter(
      (s) => s.authorId === authorId && now - s.ts < IMAGE_SPAM_BURST_WINDOW_S,
    ).length;
    return { repeated: repeats > 1, burst: burstCount >= IMAGE_SPAM_BURST_COUNT, burstCount };
  }

  getRecentImages(seconds = 60): { data: Buffer; mime: string }[] {
    const cutoff = nowSec() - seconds;
    return this.recentImages.filter((i) => i.ts > cutoff).map((i) => ({ data: i.data, mime: i.mime }));
  }

  updateBotActivity(): void {
    this.lastBotActivity = nowSec();
  }

  isBotEngaged(timeout = 60): boolean {
    return nowSec() - this.lastBotActivity < timeout;
  }

  getFormattedHistory(): string[] {
    return this.messages.map((m) => `${m.author} (ID: ${m.authorId}): ${m.content}`);
  }

  private cleanup(now: number): void {
    const cutoff = now - HISTORY_WINDOW_S;
    this.messages = this.messages.filter((m) => m.ts > cutoff).slice(-HISTORY_MAX);
    const imgCutoff = now - IMAGE_WINDOW_S;
    this.recentImages = this.recentImages.filter((i) => i.ts > imgCutoff).slice(-RECENT_IMAGES_MAX);
    this.seenImages = this.seenImages.filter((s) => s.ts > imgCutoff).slice(-SEEN_IMAGES_MAX);
  }
}
