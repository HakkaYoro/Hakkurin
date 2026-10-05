import { nowSec } from '../../../common/util';

export class Session {
  lastInteraction: number;
  isActive = false;
  private context: { ts: number; content: string }[] = [];

  constructor(
    public readonly channelId: string,
    public readonly userId: string,
  ) {
    this.lastInteraction = nowSec();
  }

  updateInteraction(): void {
    this.lastInteraction = nowSec();
  }

  activate(): void {
    this.isActive = true;
    this.lastInteraction = nowSec();
  }
}
