import { BOARD_WALK_SPEED, DOOR_OPEN_S, DOOR_SHUT_S, LEAVE_S, SIT_S, STEP_S } from '@nn/shared';
import { expect, test } from 'vitest';
import { BACK, HEAD_R, SEAT_RECLINE, boardPose, enterStage, footTargets, leaveStage } from './boarding';

const path = [{ x: 3, u: 0 }, { x: 3, u: 2.2 }, { x: 1.4, u: 2.2 }];
const walk = (2.2 + 1.6) / BOARD_WALK_SPEED;

test('getting in: walks to the door, pulls it open by the handle, steps round it, sits down, pulls it shut', () => {
  const a = enterStage(path, 0.5);
  expect(a.walk).toEqual({ x: 3, u: 0.5 * BOARD_WALK_SPEED });
  expect(a.heading).toEqual({ x: 0, u: 1 });
  expect(a).toMatchObject({ phase: null, door: 0 });
  const corner = enterStage(path, (2.2 + 0.8) / BOARD_WALK_SPEED);
  expect(corner.walk!.x).toBeCloseTo(2.2);
  expect(corner.heading).toEqual({ x: -1, u: 0 });
  // at the door: first the hand goes to the handle, the door still shut; then it swings open
  const reaching = enterStage(path, walk + 0.1);
  expect(reaching).toMatchObject({ walk: null, phase: 'handle', door: 0 });
  const opening = enterStage(path, walk + DOOR_OPEN_S - 0.1);
  expect(opening.phase).toBe('handle');
  expect(opening.door).toBeGreaterThan(0.5);
  // only with the door open the figure steps round it into the opening, then sits down
  const stepping = enterStage(path, walk + DOOR_OPEN_S + STEP_S / 2);
  expect(stepping).toMatchObject({ phase: 'step', door: 1 });
  expect(stepping.k).toBeCloseTo(0.5);
  const sitting = enterStage(path, walk + DOOR_OPEN_S + STEP_S + SIT_S / 2);
  expect(sitting).toMatchObject({ phase: 'sit', door: 1 });
  // seated, it pulls the door shut
  const shutting = enterStage(path, walk + DOOR_OPEN_S + STEP_S + SIT_S + DOOR_SHUT_S * 0.4);
  expect(shutting.phase).toBe('shut');
  expect(shutting.door).toBeGreaterThan(0);
  expect(shutting.door).toBeLessThan(1);
  expect(shutting.done).toBe(false);
  const end = enterStage(path, walk + DOOR_OPEN_S + STEP_S + SIT_S + DOOR_SHUT_S + 0.01);
  expect(end).toMatchObject({ phase: 'shut', door: 0, done: true });
});

test('getting out: the same backwards – door pushed open from the seat, out, a step back, door shut by the handle', () => {
  expect(leaveStage(0)).toMatchObject({ phase: 'shut', door: 0, done: false });
  expect(leaveStage(DOOR_SHUT_S + SIT_S / 2)).toMatchObject({ phase: 'sit', door: 1 });
  expect(leaveStage(DOOR_SHUT_S + SIT_S + STEP_S / 2)).toMatchObject({ phase: 'step', door: 1 });
  const closing = leaveStage(LEAVE_S - 0.3);
  expect(closing.phase).toBe('handle');
  expect(closing.done).toBe(false);
  expect(leaveStage(LEAVE_S + 0.01)).toMatchObject({ phase: 'handle', door: 0, done: true });
  // the door never moves while the figure is in its way: getting into or out of the seat, or stepping round it
  for (let t = 0; t <= LEAVE_S; t += 0.02) {
    const st = leaveStage(t);
    if (st.phase === 'sit' || st.phase === 'step') expect(st.door).toBe(1);
  }
});

test('feet rest on the floor ahead of the seat, closer in under a high seat', () => {
  const low = footTargets({ x: 0.37, u: 0.05, h: 0.5 }, 0.22), high = footTargets({ x: 0.47, u: 0.75, h: 1 }, 0.56);
  expect(low[0].y).toBeCloseTo(0.3);
  expect(low[0].x).toBeGreaterThan(low[1].x); // left foot on the left
  expect(low[0].z - 0.05).toBeGreaterThan(high[0].z - 0.75);
});

const SEAT = { x: 0.37, u: 0.05, h: 0.5 }, STAND = { x: 1.41, u: 0.05 }, FLOOR = 0.22, HIP = 0.95;
const at = (k: number, seat = SEAT, stand = STAND) => boardPose(k, seat, FLOOR, stand, HIP, SEAT_RECLINE, 1.47);

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
  expect(at(0.35).pitch).toBeGreaterThan(0.6); // bent well forward under the roof edge when passing the door frame
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

test('getting into the seat: the head is under the door frame before it comes inside, and stays under the roof', () => {
  // where the head is: up the bent back from the hips, leaning the way the body is turned
  const head = (b: { hip: { x: number; y: number }; pitch: number; yaw: number }) => ({
    x: b.hip.x + BACK * Math.sin(Math.max(0, b.pitch)) * Math.sin(b.yaw),
    top: b.hip.y + BACK * Math.cos(b.pitch) + HEAD_R,
  });
  for (const [seat, stand, roof] of [[SEAT, STAND, 1.47], [{ x: 0.47, u: 0.55, h: 1 }, { x: 1.49, u: 0.55 }, 1.97], [{ x: 0.33, u: -0.2, h: 0.62 }, { x: 1.3, u: -0.2 }, 1.55],
    [{ x: 0.38, u: 0.09, h: 0.47 }, { x: 1.45, u: 0.09 }, 1.44]] as const) {
    for (let k = 0; k <= 1.0001; k += 0.01) {
      const b = boardPose(k, seat, FLOOR, stand, HIP, SEAT_RECLINE, roof), h = head(b);
      // passing the door frame (the roof rail runs about 0.2 m inside the door's skin) the head has to be well below it;
      // further in, under the roof itself
      const inFrame = Math.abs(h.x) < Math.abs(seat.x) + 0.42, inside = Math.abs(h.x) < Math.abs(seat.x) + 0.2;
      if (inFrame) expect(h.top, `k=${k.toFixed(2)} roof ${roof} head x ${h.x.toFixed(2)}`).toBeLessThan(roof - (inside ? 0.06 : 0.12));
      // and it never leans further ahead than a hand's breadth over the knees once the hips are on the seat
      if (Math.abs(b.hip.x - seat.x) < 0.06) expect(BACK * Math.sin(Math.max(0, b.pitch))).toBeLessThan(0.2);
    }
  }
});
