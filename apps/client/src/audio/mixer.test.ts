import { expect, test } from 'vitest';
import { placeListener } from './mixer';

function param(): { v: number; setTargetAtTime(v: number): void } {
  const p = { v: NaN, setTargetAtTime(v: number) { p.v = v; } };
  return p;
}

test('placeListener ramps AudioParams when the listener has them', () => {
  const l = {
    positionX: param(), positionY: param(), positionZ: param(),
    forwardX: param(), forwardY: param(), forwardZ: param(),
  };
  placeListener(l as unknown as AudioListener, 3, 4, Math.PI / 2, 0);
  expect([l.positionX.v, l.positionY.v, l.positionZ.v]).toEqual([3, 0, 4]);
  expect(l.forwardX.v).toBeCloseTo(1, 6);
  expect(l.forwardZ.v).toBeCloseTo(0, 6);
});

test('placeListener falls back to setPosition/setOrientation (Firefox)', () => {
  const calls: Record<string, number[]> = {};
  const l = {
    setPosition(...a: number[]) { calls.pos = a; },
    setOrientation(...a: number[]) { calls.ori = a; },
  };
  expect(() => placeListener(l as unknown as AudioListener, 3, 4, 0, 0)).not.toThrow();
  expect(calls.pos).toEqual([3, 0, 4]);
  expect(calls.ori).toEqual([0, 0, 1, 0, 1, 0]);
});
