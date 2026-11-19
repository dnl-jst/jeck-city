import { expect, test } from 'vitest';
import { PLATE_DISTRICTS, plateText } from './plates';

test('plate text: a district, a space, then a number that starts with 0 (so it can never be a real plate)', () => {
  for (let i = 0; i < 3000; i++) {
    const m = /^([A-Z]{1,3}) (0\d{4})$/.exec(plateText(i));
    expect(m, plateText(i)).not.toBeNull();
    expect(PLATE_DISTRICTS).toContain(m![1]);
  }
});

test('plate text: the same car always has the same plate, different cars different ones', () => {
  expect(plateText(17)).toBe(plateText(17));
  const all = new Set(Array.from({ length: 3000 }, (_, i) => plateText(i)));
  expect(all.size).toBe(3000);
});

test('plate text: most cars are from Köln, some from the districts around', () => {
  const k = Array.from({ length: 3000 }, (_, i) => plateText(i)).filter((t) => t.startsWith('K ')).length;
  expect(k).toBeGreaterThan(2100);
  expect(k).toBeLessThan(2700);
});
