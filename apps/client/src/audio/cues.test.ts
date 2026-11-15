import { expect, test } from 'vitest';
import { ImpactDetector, StepClock, TramBell, landed, skidAmount } from './cues';

function countSteps(speed: number, seconds: number, grounded = true): number {
  const c = new StepClock();
  let n = 0;
  for (let i = 0; i < Math.round(seconds * 60); i++) if (c.update(speed, grounded, 1 / 60)) n++;
  return n;
}

test('walking 3 m makes 4 steps', () => {
  expect(countSteps(1.5, 2)).toBe(4);
});

test('running steps are spaced 1.5 m', () => {
  expect(countSteps(5, 3)).toBe(10);
});

test('no steps in the air or standing still', () => {
  expect(countSteps(5, 3, false)).toBe(0);
  expect(countSteps(0.2, 10)).toBe(0);
});

test('landing after a jump, not after a kerb hop', () => {
  expect(landed(false, true, 0.5)).toBe(true);
  expect(landed(false, true, 0.1)).toBe(false);
  expect(landed(true, true, 0.5)).toBe(false);
});

test('hard stop is an impact, braking is not', () => {
  const dt = 1 / 60;
  const a = new ImpactDetector();
  a.update(12, 0, dt);
  expect(a.update(0, 0, dt)).toBe(1);
  expect(a.update(12, 0, dt)).toBe(0);

  const b = new ImpactDetector();
  let v = 12;
  b.update(v, 0, dt);
  while (v > 0) {
    v = Math.max(0, v - 11 * dt);
    expect(b.update(v, 0, dt)).toBe(0);
  }

  const c = new ImpactDetector();
  c.update(12, 0, dt);
  expect(c.update(0, 0, dt)).toBe(1);
  c.update(12, 0, dt);
  expect(c.update(0, 0, dt)).toBe(0);
});

test('skid', () => {
  expect(skidAmount(10, 0, false)).toBe(0);
  expect(skidAmount(10, 5.5, false)).toBe(1);
  expect(skidAmount(12, 0, true)).toBe(1);
  expect(skidAmount(2, 0, true)).toBe(0);
});

test('tram bell', () => {
  const t = new TramBell(() => 0);
  let first = -1;
  for (let i = 1; i <= 70 * 60; i++) if (t.update(1 / 60, 50)) { first = i / 60; break; }
  expect(first).toBeCloseTo(60, 1);
  const far = new TramBell(() => 0);
  for (let i = 0; i < 300 * 60; i++) expect(far.update(1 / 60, 100)).toBe(false);
});
