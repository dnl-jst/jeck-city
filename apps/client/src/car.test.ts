import { expect, test } from 'vitest';
import { canGetOut, exitSpot, headingOf, nearestEnterableCar } from './car';

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
