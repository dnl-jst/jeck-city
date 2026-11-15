import { expect, test } from 'vitest';
import { localToWgs84, utmToLocal, wgs84ToLocal } from './geo';

test('origin maps to 0,0', () => expect(utmToLocal(356198, 5647717)).toEqual({ x: 0, z: -0 }));
test('north is negative z, east positive x', () => {
  expect(utmToLocal(356208, 5647727)).toEqual({ x: 10, z: -10 });
});
test('Wilhelmplatz centre is near origin', () => {
  const p = wgs84ToLocal(50.9630937, 6.952182);
  expect(Math.hypot(p.x, p.z)).toBeLessThan(2);
});
test('round trip', () => {
  const p = wgs84ToLocal(50.97, 6.95);
  const back = localToWgs84(p.x, p.z);
  expect(back.lat).toBeCloseTo(50.97, 6);
  expect(back.lon).toBeCloseTo(6.95, 6);
});
