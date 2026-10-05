// Rate-limit por API key (puerto de core/key_manager.py). Aislado del motor
// para que la rotación sea testeable sin tocar el cliente de Gemini.

export const LIMIT_RPM = 5;
export const LIMIT_RPD = 20;

export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((now - start) / 86_400_000);
}

export class KeyUsage {
  requestsToday = 0;
  lastResetDay = dayOfYear(new Date());
  requestsThisMinute = 0;
  lastRequestTime = 0;
  cooldownUntil = 0; // epoch s; salto esta key mientras now < cooldownUntil

  checkAndUpdate(): [boolean, string] {
    const now = Date.now() / 1000;
    const currentDay = dayOfYear(new Date());
    if (currentDay !== this.lastResetDay) {
      this.requestsToday = 0;
      this.lastResetDay = currentDay;
    }
    if (now - this.lastRequestTime > 60) this.requestsThisMinute = 0;

    if (now < this.cooldownUntil) return [false, 'Cooldown active'];
    if (this.requestsToday >= LIMIT_RPD) return [false, 'Daily limit reached'];
    if (this.requestsThisMinute >= LIMIT_RPM) return [false, 'Rate limit reached'];
    return [true, 'OK'];
  }

  registerRequest(): void {
    this.requestsToday += 1;
    this.requestsThisMinute += 1;
    this.lastRequestTime = Date.now() / 1000;
  }
}
