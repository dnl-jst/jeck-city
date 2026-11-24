/** Per-player chat throttle: token bucket that starts full. */
export class ChatThrottle {
  private tokens: number;
  private last: number | null = null;
  private throttled = false;

  constructor(
    private readonly burst = 5,
    private readonly refillMs = 2000,
  ) {
    this.tokens = burst;
  }

  /** 'warn' on the first rejected attempt of a throttle phase, 'drop' on further ones; an 'ok' ends the phase. */
  take(nowMs: number): 'ok' | 'drop' | 'warn' {
    if (this.last !== null && nowMs > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + (nowMs - this.last) / this.refillMs);
    }
    this.last = this.last === null ? nowMs : Math.max(this.last, nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.throttled = false;
      return 'ok';
    }
    if (this.throttled) return 'drop';
    this.throttled = true;
    return 'warn';
  }
}
