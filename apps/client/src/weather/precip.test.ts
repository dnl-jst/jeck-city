import { expect, test } from 'vitest';
import { PRECIP_BOX, visibleDrops } from './precip';

test('no drops without precipitation, all of them at full intensity', () => {
  expect(visibleDrops(3000, 0)).toBe(0);
  expect(visibleDrops(3000, 1)).toBe(3000);
  expect(PRECIP_BOX).toBe(40);
});

test('the drop count grows with the intensity', () => {
  let last = -1;
  for (let i = 0; i <= 20; i++) {
    const n = visibleDrops(3000, i / 20);
    expect(n).toBeGreaterThanOrEqual(last);
    last = n;
  }
  expect(visibleDrops(3000, 0.5)).toBe(1500);
});
