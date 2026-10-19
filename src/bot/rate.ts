/**
 * Actions per user per minute (#59): chat updates and mini app actions share one counter, so the
 * /start → /delete loop cannot inflate the funnel by either path. Kept in memory, because the bot
 * runs as one process (compose.yaml); a restart only resets the current minute.
 */
const MINUTE = 60_000;
export class RateLimit {
  private readonly windows = new Map<number, { start: number; count: number }>();
  constructor(readonly perMinute: number) {}
  /** Counts one action. 0 lets it through; otherwise how far over the limit this minute is (1: the first refused). */
  take(user: number, now: number): number {
    let window = this.windows.get(user);
    if (!window || now - window.start >= MINUTE) this.windows.set(user, window = { start: now, count: 0 });
    window.count++;
    return Math.max(0, window.count - this.perMinute);
  }
  /** Whole seconds until the user's minute ends, for the `retry-after` header. */
  retryAfter(user: number, now: number): number {
    const window = this.windows.get(user);
    return window ? Math.max(1, Math.ceil((window.start + MINUTE - now) / 1000)) : 0;
  }
  /** Drops finished minutes, so the map does not keep every user ever seen. */
  prune(now: number): void {
    for (const [user, window] of this.windows) if (now - window.start >= MINUTE) this.windows.delete(user);
  }
}
