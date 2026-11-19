import { expect, test } from 'vitest';
import { DEFAULT_QUALITY, DEFAULT_TOUCH_QUALITY, MAX_LAMP_LIGHTS, nextQuality, QUALITY, spreadIndices, storedQuality } from './quality';

test('high is the original look, low is the default', () => {
  expect(QUALITY.high).toEqual({
    pixelRatio: 2, antialias: true, lampLights: 8, discoDots: 8, tailLights: true, beamShadow: 1024, sunShadow: 2048, shadowRadius: 150, treeShadowRadius: 80,
    viewDistance: 650, loadRadius: 600, unloadRadius: 800, treeRadius: 250, carRadius: 150, precipDrops: 20000,
  });
  expect(DEFAULT_QUALITY).toBe('low');
  expect(MAX_LAMP_LIGHTS).toBe(8);
});

test('each lower level costs no more than the one above', () => {
  const [min, low, mid, high] = [QUALITY.minimal, QUALITY.low, QUALITY.medium, QUALITY.high];
  for (const k of ['pixelRatio', 'lampLights', 'discoDots', 'beamShadow', 'sunShadow', 'shadowRadius', 'treeShadowRadius', 'viewDistance', 'loadRadius', 'unloadRadius', 'treeRadius', 'carRadius'] as const) {
    expect(min[k]).toBeLessThanOrEqual(low[k]);
    expect(low[k]).toBeLessThanOrEqual(mid[k]);
    expect(mid[k]).toBeLessThanOrEqual(high[k]);
  }
});

test('each level draws more rain and snow than the one below', () => {
  expect(QUALITY.minimal.precipDrops).toBeLessThan(QUALITY.low.precipDrops);
  expect(QUALITY.low.precipDrops).toBeLessThan(QUALITY.medium.precipDrops);
  expect(QUALITY.medium.precipDrops).toBeLessThan(QUALITY.high.precipDrops);
});

test('every level loads the world a little short of its fog end and the shadows inside it', () => {
  for (const q of Object.values(QUALITY)) {
    expect(q.loadRadius).toBeLessThan(q.viewDistance);
    expect(q.unloadRadius).toBeGreaterThan(q.loadRadius);
    expect(q.loadRadius).toBeGreaterThanOrEqual(250); // READY_RADIUS: the spawn chunks stay loaded
    expect(q.treeShadowRadius).toBeLessThan(q.treeRadius);
    if (q.sunShadow === 0) expect(q.treeShadowRadius).toBe(0); // no shadow pass: nothing casts
  }
});

test('G cycles minimal → low → medium → high → minimal', () => {
  expect([nextQuality('minimal'), nextQuality('low'), nextQuality('medium'), nextQuality('high')]).toEqual(['low', 'medium', 'high', 'minimal']);
});

test('?quality= wins over storage; junk falls back', () => {
  expect(storedQuality('low')).toBe('low');
  expect(storedQuality('ultra')).toBe(DEFAULT_QUALITY); // no localStorage in the test env either
  expect(storedQuality(null, DEFAULT_TOUCH_QUALITY)).toBe('minimal'); // phones and tablets
});

test('the kept disco dots spread evenly round the ball', () => {
  expect([...spreadIndices(8, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect([...spreadIndices(8, 4)]).toEqual([0, 2, 4, 6]);
  expect([...spreadIndices(8, 2)]).toEqual([0, 4]);
  expect([...spreadIndices(8, 0)]).toEqual([]);
});
