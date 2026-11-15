import { expect, test } from 'vitest';
import { Vector3 } from 'three';
import { beamPattern, canGetOut, exitSpot, glareFacing, headingOf, nearestEnterableCar } from './car';

test('nearest free car within 3 m', () => {
  expect(nearestEnterableCar({ x: 0, z: 0 }, [{ id: 1, x: 2, z: 0, occupied: true }, { id: 2, x: 2.5, z: 0, occupied: false }])).toBe(2);
});
test('no car in range', () => expect(nearestEnterableCar({ x: 0, z: 0 }, [{ id: 1, x: 5, z: 0, occupied: false }])).toBeNull());
test('picks the nearest of several free cars', () => {
  expect(nearestEnterableCar({ x: 0, z: 0 }, [{ id: 1, x: 2.9, z: 0, occupied: false }, { id: 7, x: 0, z: -1.5, occupied: false }])).toBe(7);
});

// car facing south (+z): its left is east (+x), its right is west (−x), behind is north (−z)
const car = { x: 10, z: 20, heading: 0 };
test('exit 1.5 m to the left of the car when free', () => {
  const p = exitSpot(car, () => true)!;
  expect(p.x).toBeCloseTo(11.5);
  expect(p.z).toBeCloseTo(20);
});
test('left blocked: exit right; both blocked: behind; all blocked: null', () => {
  const right = exitSpot(car, (x) => x < 10)!;
  expect(right.x).toBeCloseTo(8.5);
  const behind = exitSpot(car, (x, z) => z < 18)!;
  expect(behind.x).toBeCloseTo(10);
  expect(behind.z).toBeLessThan(20 - 2.1); // clear of the 4.2 m long body
  expect(exitSpot(car, () => false)).toBeNull();
});

test('headingOf inverts the yaw quaternion of a chassis', () => {
  for (const h of [0, 1, -2.5, 3]) {
    expect(headingOf({ qx: 0, qy: Math.sin(h / 2), qz: 0, qw: Math.cos(h / 2) })).toBeCloseTo(h);
  }
});

test('getting out only below 2 m/s, forwards or reversing', () => {
  expect(canGetOut(0)).toBe(true);
  expect(canGetOut(1.9)).toBe(true);
  expect(canGetOut(-1.9)).toBe(true);
  expect(canGetOut(2.5)).toBe(false);
  expect(canGetOut(-3)).toBe(false);
});

// headlight low beam: lamps 0.8 m above the road, so the road d m ahead lies at tangent -0.8/d below the axis
const road = (d: number) => beamPattern(0, -0.8 / d);
test('low beam: brightest just below the cutoff, which meets the road 20–30 m ahead', () => {
  expect(road(25)).toBeCloseTo(1, 5);
  expect(beamPattern(0, 0.01)).toBeLessThan(0.02); // above the cutoff only faint spill: no high beam
  expect(beamPattern(0, 0.2)).toBeLessThan(0.01);
});
test('low beam: road illuminance (∝ I / d³) stays even from 5 m to the cutoff instead of a hot spot at the bumper', () => {
  const e = (d: number) => road(d) / d ** 3;
  const near = e(5), mid = e(12), far = e(25);
  expect(near / far).toBeLessThan(8);
  expect(mid / far).toBeLessThan(4);
  expect(near / far).toBeGreaterThan(0.5);
});
test('low beam: falls off smoothly sideways, no hard edge', () => {
  const y = -0.8 / 15;
  const xs = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map((x) => beamPattern(x, y));
  for (let i = 1; i < xs.length; i++) {
    expect(xs[i]!).toBeLessThan(xs[i - 1]!);
    expect(xs[i - 1]! - xs[i]!).toBeLessThan(0.35);
  }
});
test('glare: full head-on, gone beside and behind the lamp', () => {
  const fwd = new Vector3(0, 0, 1);
  expect(glareFacing(fwd, new Vector3(0, 0, 1), 3)).toBe(1);
  expect(glareFacing(fwd, new Vector3(1, 0, 0), 3)).toBe(0);
  expect(glareFacing(fwd, new Vector3(0, 0, -1), 3)).toBe(0);
  expect(glareFacing(fwd, new Vector3(Math.SQRT1_2, 0, Math.SQRT1_2), 3)).toBeLessThan(0.4);
});
