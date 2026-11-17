import { expect, test } from 'vitest';
import { LoadBrake } from './load-brake';

/** Feeds `seconds` of 60 Hz ticks taking `ms` each. */
function feed(b: LoadBrake, seconds: number, ms: number) {
  for (let i = 0; i < seconds * 60; i++) b.record(ms);
}

test('slow ticks lower the density step by step, fast ticks raise it again, within 0.1..1', () => {
  const b = new LoadBrake();
  expect(b.factor()).toBe(1);
  feed(b, 5, 15);
  expect(b.factor()).toBeCloseTo(0.9, 9);
  feed(b, 5, 15);
  expect(b.factor()).toBeCloseTo(0.8, 9);
  feed(b, 5, 8);
  expect(b.factor()).toBeCloseTo(0.9, 9);
  feed(b, 200, 15);
  expect(b.factor()).toBeCloseTo(0.1, 9);
  feed(b, 200, 5);
  expect(b.factor()).toBe(1);
});

test('between 10 and 14 ms the density stays', () => {
  const b = new LoadBrake();
  feed(b, 5, 15);
  feed(b, 20, 12);
  expect(b.factor()).toBeCloseTo(0.9, 9);
});

test('a few slow ticks (below p95) do not brake', () => {
  const b = new LoadBrake();
  for (let s = 0; s < 10; s++) for (let i = 0; i < 300; i++) b.record(i % 50 === 0 ? 30 : 6);
  expect(b.factor()).toBe(1);
});
