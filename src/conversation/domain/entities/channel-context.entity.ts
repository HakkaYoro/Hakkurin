import { nowSec } from '../../../common/util';

export const HISTORY_WINDOW_S = 3600; // 1h
export const HISTORY_MAX = 50;
export const IMAGE_WINDOW_S = 300; // 5 min

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

export class ChannelContext {
  messages: StoredMessage[] = [];
  recentImages: StoredImage[] = [];
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
    this.recentImages = this.recentImages.filter((i) => i.ts > imgCutoff);
  }
}
