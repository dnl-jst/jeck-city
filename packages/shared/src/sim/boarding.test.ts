import { describe, expect, it } from 'vitest';
import { CAR_SEATS } from '../physics/carseats';
import { CAR_SPECS } from '../physics/cartypes';
import { BOARD_WALK_SPEED, DOOR_OPEN_S, SIT_S, boardSeconds, boardingPath, fromCarPoint, pathLength, pickSeat, standPoint, toCarPoint } from './boarding';

const sp = CAR_SPECS.kleinwagen, L = CAR_SEATS.kleinwagen;
const inBody = (p: { x: number; u: number }) => Math.abs(p.x) < sp.width / 2 && Math.abs(p.u - sp.bodyZ) < sp.length / 2;
/** Samples along a path. */
const along = (path: { x: number; u: number }[]) => path.slice(1).flatMap((b, i) => {
  const a = path[i]!;
  return Array.from({ length: 21 }, (_, k) => ({ x: a.x + (b.x - a.x) * k / 20, u: a.u + (b.u - a.u) * k / 20 }));
});

describe('boarding', () => {
  it('stands beside the seat, outside the door, on the seat\'s side', () => {
    const s = standPoint(L, 0);
    expect(s.x).toBeGreaterThan(sp.width / 2 + 0.3);
    expect(s.u).toBeCloseTo(L.seats[0]!.u, 1);
    expect(standPoint(L, 1).x).toBeLessThan(-sp.width / 2 - 0.3);
  });

  it('walks straight to the door from the same side', () => {
    const path = boardingPath(sp, L, 0, { x: 1.6, u: -0.8 });
    expect(path).toHaveLength(2);
    expect(path[1]).toEqual(standPoint(L, 0));
  });

  it('walks round the car from the other side, never through it, by the shorter end', () => {
    const fromRearRight = boardingPath(sp, L, 0, { x: -1.5, u: -1.2 });
    expect(fromRearRight.length).toBeGreaterThan(2);
    expect(along(fromRearRight).some(inBody)).toBe(false);
    expect(Math.min(...fromRearRight.map((p) => p.u))).toBeLessThan(sp.bodyZ - sp.length / 2); // round the rear
    const fromFrontRight = boardingPath(sp, L, 0, { x: -1.5, u: 1.6 });
    expect(Math.max(...fromFrontRight.map((p) => p.u))).toBeGreaterThan(sp.bodyZ + sp.length / 2); // round the front
    expect(along(fromFrontRight).some(inBody)).toBe(false);
    expect(fromFrontRight.at(-1)).toEqual(standPoint(L, 0));
  });

  it('from straight behind the car it goes round one rear corner only', () => {
    const path = boardingPath(sp, L, 0, { x: 0, u: -3 });
    expect(along(path).some(inBody)).toBe(false);
    expect(path.every((p) => p.x >= -0.01)).toBe(true);
  });

  it('takes the walk plus opening the door and sitting down', () => {
    const path = boardingPath(sp, L, 0, { x: 1.6, u: -0.8 });
    expect(boardSeconds(path)).toBeCloseTo(pathLength(path) / BOARD_WALK_SPEED + DOOR_OPEN_S + SIT_S, 6);
    expect(boardSeconds([standPoint(L, 0), standPoint(L, 0)])).toBeCloseTo(DOOR_OPEN_S + SIT_S, 6);
  });

  it('converts between the world and a car\'s frame', () => {
    const car = { x: 10, z: -4, heading: 0.7 };
    const p = toCarPoint(car, 12, -3);
    const w = fromCarPoint(car, p);
    expect(w.x).toBeCloseTo(12, 6);
    expect(w.z).toBeCloseTo(-3, 6);
    // one metre ahead of a car heading north-east-ish lies along (sin h, cos h)
    const ahead = toCarPoint(car, 10 + Math.sin(0.7), -4 + Math.cos(0.7));
    expect(ahead.u).toBeCloseTo(1, 6);
    expect(ahead.x).toBeCloseTo(0, 6);
  });
});

describe('seat choice', () => {
  const none = [false, false, false, false];
  it('gives the seat behind the door one stands at', () => {
    expect(pickSeat(sp, L, none, { x: 1.6, u: 0.1 })).toBe(0); // driver's door
    expect(pickSeat(sp, L, none, { x: -1.6, u: 0.1 })).toBe(1); // front passenger
    expect(pickSeat(sp, L, none, { x: 1.6, u: -0.8 })).toBe(2); // rear left
    expect(pickSeat(sp, L, none, { x: -1.6, u: -0.8 })).toBe(3);
  });

  it('with that seat taken: the free seat with the shortest walk to its door', () => {
    expect(pickSeat(sp, L, [true, false, false, false], { x: 1.6, u: 0.1 })).toBe(2); // same side, the rear door
    // the whole left side taken: round the car by the shorter end – the rear from the driver's door, the front from the wing
    expect(pickSeat(sp, L, [true, false, true, false], { x: 1.6, u: 0.1 })).toBe(3);
    expect(pickSeat(sp, L, [true, false, true, false], { x: 1.6, u: 1.6 })).toBe(1);
  });

  it('a full car has no seat', () => {
    expect(pickSeat(sp, L, [true, true, true, true], { x: 1.6, u: 0.1 })).toBeNull();
    expect(pickSeat(CAR_SPECS.smart, CAR_SEATS.smart, [true, true], { x: 1.6, u: 0 })).toBeNull();
  });
});
