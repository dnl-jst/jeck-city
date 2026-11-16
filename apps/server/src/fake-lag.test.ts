import { describe, expect, it, vi } from 'vitest';
import { LagLine, STALL_MS } from './fake-lag';

describe('LagLine', () => {
  it('delays by ms ± jitter', () => {
    vi.useFakeTimers();
    const r = [0.5, 1]; // jitter factor 0 → delay 100; 1 * 100 >= stallPct → no stall
    const line = new LagLine({ ms: 100, jitterMs: 20, stallPct: 0 }, () => r.shift() ?? 1);
    const got: number[] = [];
    line.push(() => got.push(Date.now()), Date.now());
    vi.advanceTimersByTime(99);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(got).toHaveLength(1);
    vi.useRealTimers();
  });

  it('a stalled message holds back later ones, order is kept', () => {
    vi.useFakeTimers();
    // message 1: no jitter, stalls (+200); message 2: no jitter, no stall
    const r = [0.5, 0, 0.5, 0.99];
    const line = new LagLine({ ms: 10, jitterMs: 0, stallPct: 1 }, () => r.shift()!);
    const got: string[] = [];
    const now = Date.now();
    line.push(() => got.push('a'), now);
    line.push(() => got.push('b'), now);
    vi.advanceTimersByTime(10 + STALL_MS - 1);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(got).toEqual(['a', 'b']);
    vi.useRealTimers();
  });

  it('cancel drops what is in flight', () => {
    vi.useFakeTimers();
    const line = new LagLine({ ms: 50, jitterMs: 0, stallPct: 0 });
    const got: number[] = [];
    line.push(() => got.push(1));
    line.cancel();
    vi.advanceTimersByTime(1000);
    expect(got).toEqual([]);
    vi.useRealTimers();
  });
});
