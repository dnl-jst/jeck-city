import { describe, expect, it } from 'vitest';
import { CAR_SEATS } from './carseats';
import { CAR_SPECS } from './cartypes';

describe('CAR_SEATS', () => {
  it('kleinwagen: four seats, each behind its own door inside the body', () => {
    const L = CAR_SEATS.kleinwagen!, sp = CAR_SPECS.kleinwagen;
    expect(L.seats).toHaveLength(4);
    expect(new Set(L.seats.map((s) => s.door)).size).toBe(4);
    expect(L.seats[0]!.x).toBeGreaterThan(0); // the driver sits on the left
    for (const s of L.seats) {
      const d = L.doors[s.door]!;
      expect(Math.abs(s.x)).toBeLessThan(sp.width / 2 - 0.3);
      expect(s.u).toBeLessThan(d.hingeU);
      expect(s.u).toBeGreaterThan(d.rearU);
      expect(Math.sign(d.hingeX)).toBe(Math.sign(s.x));
    }
  });
});
