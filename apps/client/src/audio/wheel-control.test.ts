import { expect, test } from 'vitest';
import { HOLD_S, PICK_RADIUS_PX, WHEEL_SLOTS, WheelControl } from './wheel-control';
import type { StationId } from './stations';

const current: StationId = 'koellefornia';
const step = (w: WheelControl, held: boolean, dt = 0.05, dx = 0, dy = 0) => w.update({ held, dx, dy, dt, current });
/** Holds R long enough to open the wheel. */
function opened(): WheelControl {
  const w = new WheelControl();
  for (let t = 0; t < HOLD_S + 0.05; t += 0.05) step(w, true);
  return w;
}

test('slots and constants', () => {
  expect(WHEEL_SLOTS).toEqual(['koellefornia', 'radiokoeln', 'einslive', null]);
  expect(HOLD_S).toBe(0.2);
  expect(PICK_RADIUS_PX).toBe(40);
});

test('tap is next station', () => {
  const w = new WheelControl();
  const rs = [step(w, true), step(w, true)];
  const last = step(w, false);
  expect(rs.some((r) => r.open)).toBe(false);
  expect(last.tap).toBe(true);
  expect(last.open).toBe(false);
  expect(last.commit).toBeUndefined();
  expect(step(w, false).tap).toBeUndefined(); // only once
});

test('hold opens the wheel', () => {
  const w = new WheelControl();
  let r = step(w, true, 0.1);
  expect(r.open).toBe(false);
  r = step(w, true, 0.15);
  expect(r.open).toBe(true);
  expect(r.highlighted).toBe(current);
});

test('point and release selects', () => {
  const pick = (dx: number, dy: number) => step(opened(), true, 0.016, dx, dy).highlighted;
  expect(pick(60, 0)).toBe('radiokoeln');
  expect(pick(0, 60)).toBe('einslive');
  expect(pick(-60, 0)).toBeNull();
  expect(pick(0, -60)).toBe('koellefornia');
  const w = opened();
  expect(step(w, true, 0.016, 60, 0).highlighted).toBe('radiokoeln');
  expect(step(w, true, 0.016, -60, 60).highlighted).toBe('einslive');
  const r = step(w, false);
  expect(r.open).toBe(false);
  expect(r.commit).toBe('einslive');
  expect(r.tap).toBeUndefined();
});

test('the pointer vector is clamped, so turning back needs no huge sweep', () => {
  const w = opened();
  step(w, true, 0.016, 1000, 0);
  expect(step(w, true, 0.016, -130, 0).highlighted).toBeNull(); // clamped to 80 px: 80 − 130 = −50
});

test('small movement keeps current', () => {
  const w = opened();
  const r = step(w, true, 0.016, 10, 0);
  expect(r.open).toBe(true);
  expect(r.highlighted).toBe(current);
  expect(step(w, false).commit).toBe(current);
});

test('cancel closes without commit', () => {
  const w = opened();
  step(w, true, 0.016, 60, 0);
  w.cancel();
  const r = step(w, true);
  expect(r.open).toBe(false);
  const out = step(w, false);
  expect(out.commit).toBeUndefined();
  expect(out.tap).toBeUndefined(); // the held-through key is not a tap either
  expect(step(w, true).open).toBe(false);
});
