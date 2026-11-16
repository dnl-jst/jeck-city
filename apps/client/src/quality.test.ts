import { expect, test } from 'vitest';
import { DEFAULT_QUALITY, MAX_LAMP_LIGHTS, nextQuality, QUALITY, spreadIndices, storedQuality } from './quality';

test('high is the original look, medium is the default', () => {
  expect(QUALITY.high).toMatchObject({ pixelRatio: 2, antialias: true, lampLights: 8, discoDots: 8, tailLights: true, beamShadow: 1024, sunShadow: 2048, shadowRadius: 150, treeShadowRadius: 80 });
  expect(DEFAULT_QUALITY).toBe('medium');
  expect(MAX_LAMP_LIGHTS).toBe(8);
});

test('each lower level costs no more than the one above', () => {
  const [low, mid, high] = [QUALITY.low, QUALITY.medium, QUALITY.high];
  for (const k of ['pixelRatio', 'lampLights', 'discoDots', 'beamShadow', 'sunShadow', 'shadowRadius', 'treeShadowRadius'] as const) {
    expect(low[k]).toBeLessThanOrEqual(mid[k]);
    expect(mid[k]).toBeLessThanOrEqual(high[k]);
  }
});

test('G cycles low → medium → high → low', () => {
  expect([nextQuality('low'), nextQuality('medium'), nextQuality('high')]).toEqual(['medium', 'high', 'low']);
});

test('?quality= wins over storage; junk falls back', () => {
  expect(storedQuality('low')).toBe('low');
  expect(storedQuality('ultra')).toBe(DEFAULT_QUALITY); // no localStorage in the test env either
});

test('the kept disco dots spread evenly round the ball', () => {
  expect([...spreadIndices(8, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect([...spreadIndices(8, 4)]).toEqual([0, 2, 4, 6]);
  expect([...spreadIndices(8, 2)]).toEqual([0, 4]);
  expect([...spreadIndices(8, 0)]).toEqual([]);
});
