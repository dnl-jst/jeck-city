import { describe, expect, it } from 'vitest';
import { INTERP_DELAY_S, TICK_HZ } from '@nn/shared';
import { ServerClock } from './clock';

/** Deterministic pseudo-random in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('ServerClock', () => {
  it('clock converges with 30 ms jitter within 2 s', () => {
    const rnd = rng(7);
    const clock = new ServerClock();
    const LATENCY = 40; // ms, the fastest packet
    const SERVER_START = 5000; // server tick when the local clock reads 0
    for (let t = 1000; t <= 3000; t += 50) { // 20 Hz; the first snapshot arrives at 1 s, the check is 2 s later
      const sendTime = t - LATENCY - rnd() * 30;
      clock.onSnapshot(Math.round(SERVER_START + (sendTime * TICK_HZ) / 1000), t);
    }
    // after 2 s of snapshots: the estimate is the true server tick at (now - fastest latency)
    const now = 3000;
    const truth = SERVER_START + ((now - LATENCY) * TICK_HZ) / 1000;
    expect(Math.abs(clock.estimate(now) - truth)).toBeLessThan(1);
    expect(clock.renderTick(now)).toBeCloseTo(clock.estimate(now) - INTERP_DELAY_S * TICK_HZ);
  });

  it('drops a glitched sample but restarts when the server really moved', () => {
    const clock = new ServerClock();
    for (let i = 0; i < 20; i++) clock.onSnapshot(1000 + i * 3, i * 50);
    const before = clock.estimate(1000);
    clock.onSnapshot(99999, 1000); // one wild sample
    expect(clock.estimate(1000)).toBeCloseTo(before);
    for (let i = 0; i < 12; i++) clock.onSnapshot(50000 + i * 3, 1000 + i * 50);
    expect(clock.estimate(1550)).toBeGreaterThan(49000);
  });

  it('is not ready before the first snapshot', () => {
    expect(new ServerClock().ready).toBe(false);
  });
});
