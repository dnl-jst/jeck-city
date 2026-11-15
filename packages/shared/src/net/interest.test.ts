import { expect, test } from 'vitest';
import { Interest } from './interest';

test('hysteresis: enter at 250 m, leave beyond 270 m', () => {
  const at = (d: number) => [{ key: 'c1', x: d, z: 0 }];
  const f = { x: 0, z: 0 };
  const far = new Interest();
  expect(far.update(f, at(260)).has('c1')).toBe(false);
  expect(far.update(f, at(249)).has('c1')).toBe(true);
  expect(far.update(f, at(265)).has('c1')).toBe(true);
  expect(far.update(f, at(271)).has('c1')).toBe(false);
  expect(far.update(f, at(265)).has('c1')).toBe(false); // out again: needs to come back within 250
  expect(far.update(f, []).size).toBe(0);
});
