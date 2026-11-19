import { BOARD_WALK_SPEED, DOOR_OPEN_S, LEAVE_S, SIT_S } from '@nn/shared';
import { expect, test } from 'vitest';
import { DOOR_SHUT_S, SEAT_RECLINE, boardPose, enterStage, footTargets, leaveStage } from './boarding';

const path = [{ x: 3, u: 0 }, { x: 3, u: 2.2 }, { x: 1.4, u: 2.2 }];
const walk = (2.2 + 1.6) / BOARD_WALK_SPEED;

test('getting in: walks the path, opens the door, slides into the seat, shuts the door', () => {
  const a = enterStage(path, 0.5);
  expect(a.walk).toEqual({ x: 3, u: 0.5 * BOARD_WALK_SPEED });
  expect(a.heading).toEqual({ x: 0, u: 1 });
  expect(a.door).toBe(0);
  const corner = enterStage(path, (2.2 + 0.8) / BOARD_WALK_SPEED);
  expect(corner.walk!.x).toBeCloseTo(2.2);
  expect(corner.heading).toEqual({ x: -1, u: 0 });
  const opening = enterStage(path, walk + DOOR_OPEN_S / 2);
  expect(opening.walk).toBeNull();
  expect(opening.door).toBeCloseTo(0.5);
  expect(opening.slide).toBe(0);
  const sitting = enterStage(path, walk + DOOR_OPEN_S + SIT_S / 2);
  expect(sitting.door).toBe(1);
  expect(sitting.slide).toBeGreaterThan(0.3);
  expect(sitting.slide).toBeLessThan(0.7);
  const shutting = enterStage(path, walk + DOOR_OPEN_S + SIT_S + DOOR_SHUT_S / 2);
  expect(shutting.slide).toBe(1);
  expect(shutting.door).toBeCloseTo(0.5);
  expect(shutting.done).toBe(false);
  const end = enterStage(path, walk + DOOR_OPEN_S + SIT_S + DOOR_SHUT_S + 0.01);
  expect(end).toMatchObject({ door: 0, slide: 1, done: true });
});

test('getting out: door open, out of the seat, door shut, done after LEAVE_S', () => {
  expect(leaveStage(0)).toMatchObject({ door: 0, slide: 1, done: false });
  expect(leaveStage(DOOR_OPEN_S + SIT_S / 2).door).toBe(1);
  expect(leaveStage(DOOR_OPEN_S + SIT_S + 0.01).slide).toBe(0);
  expect(leaveStage(LEAVE_S - 0.05).done).toBe(false);
  expect(leaveStage(LEAVE_S + 0.01)).toMatchObject({ door: 0, slide: 0, done: true });
});

test('feet rest on the floor ahead of the seat, closer in under a high seat', () => {
  const low = footTargets({ x: 0.37, u: 0.05, h: 0.5 }, 0.22), high = footTargets({ x: 0.47, u: 0.75, h: 1 }, 0.56);
  expect(low[0].y).toBeCloseTo(0.3);
  expect(low[0].x).toBeGreaterThan(low[1].x); // left foot on the left
  expect(low[0].z - 0.05).toBeGreaterThan(high[0].z - 0.75);
});

const SEAT = { x: 0.37, u: 0.05, h: 0.5 }, STAND = { x: 1.41, u: 0.05 }, FLOOR = 0.22, HIP = 0.95;
const at = (k: number, seat = SEAT, stand = STAND) => boardPose(k, seat, FLOOR, stand, HIP, SEAT_RECLINE);

test('getting into the seat: from standing at the door, turned to the car, to sitting, facing ahead', () => {
  const a = at(0), b = at(1);
  expect(a.hip).toMatchObject({ x: STAND.x, y: HIP, z: STAND.u });
  expect(Math.sin(a.yaw)).toBeLessThan(-0.8); // looks towards the car (−x from the left door)
  expect(a.feet[0].y).toBeCloseTo(0.08);
  expect(b.hip).toMatchObject({ x: SEAT.x, y: SEAT.h, z: SEAT.u });
  expect(b.yaw).toBeCloseTo(0);
  expect(b.pitch).toBeCloseTo(-SEAT_RECLINE);
  const feet = footTargets(SEAT, FLOOR);
  expect(b.feet[0].distanceTo(feet[0])).toBeLessThan(1e-6);
  expect(b.feet[1].distanceTo(feet[1])).toBeLessThan(1e-6);
});

test('getting into the seat: the leg next to the car goes in first, the body ducks, the hips only go down', () => {
  const mid = at(0.5);
  // left door: turned forward the right foot is the one next to the car
  expect(mid.feet[1].x).toBeLessThan(SEAT.x + 0.3);
  expect(mid.feet[0].x).toBeGreaterThan(SEAT.x + 0.6); // the other still stands outside
  expect(mid.feet[0].y).toBeCloseTo(0.08);
  expect(mid.pitch).toBeGreaterThan(0.25); // leaning forward under the roof edge
  let y = Infinity;
  for (let k = 0; k <= 1.0001; k += 0.05) {
    expect(at(k).hip.y).toBeLessThanOrEqual(y + 1e-9);
    y = at(k).hip.y;
  }
  expect(Math.max(...[0.72, 0.8, 0.9].map((k) => at(k).feet[0].y))).toBeGreaterThan(0.3); // the trailing foot lifts over the sill
});

test('getting into the seat: mirrored on the right side', () => {
  const seat = { ...SEAT, x: -SEAT.x }, stand = { ...STAND, x: -STAND.x };
  const l = at(0.5), r = at(0.5, seat, stand);
  expect(r.hip.x).toBeCloseTo(-l.hip.x);
  expect(r.yaw).toBeCloseTo(-l.yaw);
  expect(r.feet[0].x).toBeCloseTo(-l.feet[1].x); // the left foot is now the one next to the car
  expect(r.feet[0].y).toBeCloseTo(l.feet[1].y);
});
