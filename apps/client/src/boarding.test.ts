import { BOARD_WALK_SPEED, DOOR_OPEN_S, LEAVE_S, SIT_S } from '@nn/shared';
import { expect, test } from 'vitest';
import { DOOR_SHUT_S, enterStage, footTargets, leaveStage } from './boarding';

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
