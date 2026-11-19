import { expect, test } from 'vitest';
import type { TerrainGrid } from '../assets/terrain';
import { VEHICLE_REST_Y } from '../physics/vehicle';
import { CRANK_AT, DOOR_CLOSE_AT, ENGINE_CATCH_S, Ignition, type IgnitionEvent } from './ignition';
import { canGetOut, exitSpot, headingOf, nearestEnterableCar, parkedPose } from './rules';

/** 100×100 m grid with height = gx·x + gz·z. */
function plane(gx: number, gz: number): TerrainGrid {
  const cols = 101, rows = 101, heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = gx * c + gz * r;
  return { x0: 0, z0: 0, cols, rows, datum: 0, heights };
}

test('parkedPose on flat ground: the pure yaw quaternion', () => {
  for (const h of [0, 0.7, -2, Math.PI]) {
    const p = parkedPose(40, 50, h, plane(0, 0));
    expect(p.y).toBeCloseTo(VEHICLE_REST_Y, 6);
    expect(p.qx).toBeCloseTo(0, 12);
    expect(p.qy).toBeCloseTo(Math.sin(h / 2), 12);
    expect(p.qz).toBeCloseTo(0, 12);
    expect(p.qw).toBeCloseTo(Math.cos(h / 2), 12);
  }
});

test('parkedPose on a slope: tilt about z (rising along +x) times the yaw, heading kept', () => {
  // normal (−0.1, 1, 0)/|…|: the tilt from up is a rotation by atan(0.1) about +z
  const th = Math.atan(0.1), sz = Math.sin(th / 2), cz = Math.cos(th / 2);
  for (const h of [0, 1.2, -2.5]) {
    const sy = Math.sin(h / 2), cy = Math.cos(h / 2);
    const p = parkedPose(40, 50, h, plane(0.1, 0));
    expect(p.y).toBeCloseTo(4 + VEHICLE_REST_Y, 4);
    // (0, 0, sz, cz) · (0, sy, 0, cy)
    expect(p.qx).toBeCloseTo(-sz * sy, 6);
    expect(p.qy).toBeCloseTo(cz * sy, 6);
    expect(p.qz).toBeCloseTo(sz * cy, 6);
    expect(p.qw).toBeCloseTo(cz * cy, 6);
    expect(headingOf(p)).toBeCloseTo(h, 2);
  }
});

test('ignition in ticks: door at 21, crank at 30, running at 84', () => {
  const ig = new Ignition();
  expect(ig.state).toBe('off');
  expect(ig.lightLevel()).toBe(0);
  ig.start();
  const seen: [IgnitionEvent, number][] = [];
  const light: number[] = [];
  for (let t = 1; t <= 120; t++) {
    for (const e of ig.update()) seen.push([e, t]);
    light.push(ig.lightLevel());
  }
  expect(seen).toEqual([
    ['doorClose', Math.round(DOOR_CLOSE_AT * 60)], ['crank', Math.round(CRANK_AT * 60)], ['running', Math.round((CRANK_AT + ENGINE_CATCH_S) * 60)],
  ]);
  expect(seen.map(([, t]) => t)).toEqual([21, 30, 84]);
  expect(light[28]).toBe(0); // tick 29
  expect(light[29]).toBe(0.5); // tick 30: the starter turns
  expect(light[82]).toBe(0.5);
  expect(light[83]).toBe(1);
  expect(ig.state).toBe('running');
  ig.stop();
  expect(ig.state).toBe('off');
  expect(ig.lightLevel()).toBe(0);
  expect(ig.update()).toEqual([]);
});

test('ignition: stop while starting, restart from the beginning', () => {
  const ig = new Ignition();
  ig.start();
  for (let t = 0; t < 40; t++) ig.update();
  ig.stop();
  for (let t = 0; t < 100; t++) expect(ig.update()).toEqual([]);
  ig.start();
  expect(ig.lightLevel()).toBe(0);
  const ev: IgnitionEvent[] = [];
  for (let t = 0; t < 84; t++) ev.push(...ig.update());
  expect(ev).toEqual(['doorClose', 'crank', 'running']);
});

// moved from the client's car.test.ts
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

test('ignition: started with a delay (the walk to the door), every event comes that many ticks later', () => {
  const ig = new Ignition();
  ig.start(90);
  const seen: [IgnitionEvent, number][] = [];
  for (let t = 1; t <= 300; t++) for (const e of ig.update()) seen.push([e, t]);
  expect(seen).toEqual([
    ['doorClose', 90 + Math.round(DOOR_CLOSE_AT * 60)], ['crank', 90 + Math.round(CRANK_AT * 60)],
    ['running', 90 + Math.round((CRANK_AT + ENGINE_CATCH_S) * 60)],
  ]);
  const late = new Ignition();
  late.start(90);
  for (let t = 0; t < 90; t++) late.update();
  expect(late.state).toBe('starting');
  expect(late.lightLevel()).toBe(0); // still walking: no lamps yet
});

test('exit spot: beside the seat (ahead of the car\'s middle by the seat\'s position), not beside the middle', () => {
  const car = { x: 0, z: 0, heading: 0 }; // forward = +z, left = +x
  expect(exitSpot(car, () => true, 4, 0.7)).toEqual({ x: 1.5, z: 0.7 });
  // left blocked: the right side, at the same position along the car
  const right = exitSpot(car, (x) => x < 0, 4, 0.7)!;
  expect(right.x).toBeCloseTo(-1.5);
  expect(right.z).toBeCloseTo(0.7);
});
