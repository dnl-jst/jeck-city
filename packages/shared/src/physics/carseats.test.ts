import { describe, expect, it } from 'vitest';
import { CAR_SEATS } from './carseats';
import { CAR_SPECS, CAR_TYPES } from './cartypes';

describe('CAR_SEATS', () => {
  it('has a layout for every car type: four seats in the two cars with rear doors, two in the others', () => {
    expect(CAR_TYPES.map((t) => CAR_SEATS[t]?.seats.length)).toEqual([4, 4, 2, 2]);
  });

  it.each(CAR_TYPES)('%s: every seat behind its own door inside the body, the driver on the left', (type) => {
    const L = CAR_SEATS[type]!, sp = CAR_SPECS[type];
    expect(new Set(L.seats.map((s) => s.door)).size).toBe(L.seats.length);
    expect(L.seats[0]!.x).toBeGreaterThan(0);
    expect(L.seats[0]!.door).toBe('door_fl');
    for (const s of L.seats) {
      const d = L.doors[s.door]!;
      expect(Math.abs(s.x)).toBeLessThan(sp.width / 2 - 0.3);
      expect(s.u).toBeLessThan(d.hingeU);
      expect(s.u).toBeGreaterThan(d.rearU);
      expect(Math.sign(d.hingeX)).toBe(Math.sign(s.x));
      expect(Math.abs(d.hingeX)).toBeLessThan(sp.width / 2 + 0.02);
    }
  });

  it('front doors are longer than rear doors', () => {
    for (const type of CAR_TYPES) {
      const d = CAR_SEATS[type]!.doors;
      if (d.door_rl) expect(d.door_fl!.hingeU - d.door_fl!.rearU).toBeGreaterThan(d.door_rl.hingeU - d.door_rl.rearU);
    }
  });
});
