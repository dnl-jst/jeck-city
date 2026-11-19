import { expect, test } from 'vitest';
import { PLATE_CELLS, PLATE_GLYPHS, decodePlate, encodePlate } from './plates';

test('plate code: the text centred in the cells, three glyphs per number, readable back', () => {
  expect(PLATE_CELLS).toBe(9);
  const code = encodePlate('K 04217');
  expect(code).toHaveLength(3);
  for (const c of code) expect(c).toBeLessThan(32 ** 3);
  expect(decodePlate(code)).toBe(' K 04217 ');
  expect(decodePlate(encodePlate('LEV 00042'))).toBe('LEV 00042');
});

test('plate code: every character of a plate has a glyph; unknown ones become blanks', () => {
  for (const ch of 'KBNSUMGLEVD 0123456789') expect(PLATE_GLYPHS, ch).toContain(ch);
  expect(decodePlate(encodePlate('K ?1'))).toBe('  K  1   ');
});
