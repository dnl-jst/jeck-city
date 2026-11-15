import { INTERP_DELAY_S, TICK_HZ } from '@nn/shared';

const WINDOW = 60;        // samples kept (3 s at 20 Hz)
const SLEW_TICKS = 0.25;  // the estimate moves at most this far per sample (no visible jumps)
const SNAP_TICKS = 12;    // a correction this large (200 ms) is not jitter: apply at once
const OUTLIER_TICKS = 12; // a sample this far above the window's median is a glitch: drop it ...
const RESTART_AFTER = 10; // ... unless this many in a row agree: the server restarted, start over

/**
 * Estimates the server tick from snapshot arrivals. Each arrival gives offset = serverTick - localTicks; network delay
 * and jitter only ever make a sample too small, so the best offset is the window's largest sample (the fastest
 * packet). The estimate slews towards it.
 */
export class ServerClock {
  private samples: number[] = [];
  private offset: number | null = null;
  private outliers = 0;

  /** Feed one arrival: the server tick it carries and the local time in ms (performance.now). */
  onSnapshot(serverTick: number, nowMs: number): void {
    const sample = serverTick - (nowMs * TICK_HZ) / 1000;
    if (this.offset === null) {
      this.offset = sample;
      this.samples = [sample];
      return;
    }
    if (this.samples.length >= 5 && sample > median(this.samples) + OUTLIER_TICKS) {
      if (++this.outliers < RESTART_AFTER) return;
      this.samples = [];
      this.offset = sample;
    }
    this.outliers = 0;
    this.samples.push(sample);
    if (this.samples.length > WINDOW) this.samples.shift();
    const d = Math.max(...this.samples) - this.offset;
    this.offset += Math.abs(d) > SNAP_TICKS ? d : Math.max(-SLEW_TICKS, Math.min(SLEW_TICKS, d));
  }

  get ready(): boolean {
    return this.offset !== null;
  }

  /** The server tick right now (fractional). Before the first snapshot: 0. */
  estimate(nowMs: number): number {
    return this.offset === null ? 0 : (nowMs * TICK_HZ) / 1000 + this.offset;
  }

  /** The tick remote entities are drawn at: the estimate minus INTERP_DELAY_S. */
  renderTick(nowMs: number): number {
    return this.estimate(nowMs) - INTERP_DELAY_S * TICK_HZ;
  }

  reset(): void {
    this.samples = [];
    this.offset = null;
    this.outliers = 0;
  }
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
}
