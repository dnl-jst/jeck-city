import { Vector3 } from 'three';
import { expect, test } from 'vitest';
import { LOOP_S, loopSpeed, PRECIP_AHEAD, PRECIP_BELOW, PRECIP_BOX, PRECIP_HEIGHT, visibleDrops, volumeOrigin } from './precip';

test('no drops without precipitation, all of them at full intensity', () => {
  expect(visibleDrops(3000, 0)).toBe(0);
  expect(visibleDrops(3000, 1)).toBe(3000);
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

test('every quantised fall speed falls a whole number of volume heights per loop, near the asked factor', () => {
  for (const speed of [9, 1]) {
    const step = PRECIP_HEIGHT / (speed * LOOP_S);
    for (let f = 0.7; f <= 1.3; f += 0.0137) {
      const q = loopSpeed(speed, f);
      const heights = (speed * q * LOOP_S) / PRECIP_HEIGHT;
      expect(Math.abs(heights - Math.round(heights))).toBeLessThan(1e-6);
      expect(Math.abs(q - f)).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
  }
});

test('the volume sits mostly ahead of the camera, along the horizontal view direction', () => {
  const o = new Vector3();
  volumeOrigin(new Vector3(100, 5, 200), 0, -1, o); // looking north (-z)
  expect(o.x).toBeCloseTo(100 - PRECIP_BOX / 2);
  expect(o.y).toBeCloseTo(5 - PRECIP_BELOW);
  expect(o.z).toBeCloseTo(200 - PRECIP_AHEAD - PRECIP_BOX / 2);
  // camera inside the box, near its back (+z) edge: PRECIP_BOX / 2 + PRECIP_AHEAD from the low corner
  expect(200 - o.z).toBeGreaterThan(PRECIP_BOX / 2);
  expect(200 - o.z).toBeLessThan(PRECIP_BOX);
  // a direction that is not unit length (looking down at an angle) still pushes PRECIP_AHEAD horizontally
  volumeOrigin(new Vector3(0, 0, 0), 0.3, 0, o);
  expect(o.x).toBeCloseTo(PRECIP_AHEAD - PRECIP_BOX / 2);
  // straight down: no horizontal direction, centred
  volumeOrigin(new Vector3(0, 0, 0), 0, 0, o);
  expect(o.x).toBeCloseTo(-PRECIP_BOX / 2);
});
