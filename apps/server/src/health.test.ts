import { describe, expect, it } from 'vitest';
import { HEALTH_WINDOW, TickStats } from './health';

describe('TickStats', () => {
  it('p95 and dropped steps over the last 600 ticks only', () => {
    const s = new TickStats();
    expect(s.health(0)).toEqual({ players: 0, tickP95Ms: 0, dropped: 0 });
    s.record(50);
    s.drop(3);
    for (let i = 0; i < HEALTH_WINDOW; i++) s.record(1); // pushes the slow, dropping tick out of the window
    expect(s.health(2)).toEqual({ players: 2, tickP95Ms: 1, dropped: 0 });
    for (let i = 0; i < 100; i++) s.record(10);
    s.drop(2);
    const h = s.health(1);
    expect(h.dropped).toBe(2);
    expect(h.tickP95Ms).toBe(10);
  });
});
