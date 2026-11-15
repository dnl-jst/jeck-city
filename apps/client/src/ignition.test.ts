import { expect, test } from 'vitest';
import { CRANK_AT, DOOR_CLOSE_AT, ENGINE_CATCH_S, Ignition, type IgnitionEvent } from './ignition';

test('sequence', () => {
  const ig = new Ignition();
  expect(ig.state).toBe('off');
  ig.start();
  expect(ig.state).toBe('starting');
  const seen: { e: IgnitionEvent; t: number }[] = [];
  let t = 0;
  for (let i = 0; i < 300; i++) {
    t += 1 / 60;
    for (const e of ig.update(1 / 60)) seen.push({ e, t });
  }
  expect(seen.map((s) => s.e)).toEqual(['doorClose', 'crank', 'running']);
  expect(seen[0]!.t).toBeGreaterThanOrEqual(DOOR_CLOSE_AT - 1e-9);
  expect(seen[1]!.t).toBeGreaterThanOrEqual(CRANK_AT - 1e-9);
  expect(seen[2]!.t).toBeGreaterThanOrEqual(CRANK_AT + ENGINE_CATCH_S - 1e-9);
  expect(seen[2]!.t).toBeLessThan(CRANK_AT + ENGINE_CATCH_S + 1 / 60 + 1e-9);
  expect(ig.state).toBe('running');
});

test('stop during start', () => {
  const ig = new Ignition();
  ig.start();
  ig.update(0.6);
  ig.stop();
  expect(ig.state).toBe('off');
  expect(ig.update(5)).toEqual([]);
  expect(ig.state).toBe('off');
});

test('lights', () => {
  const ig = new Ignition();
  expect(ig.lightPower(() => 1)).toBe(0);
  ig.start();
  ig.update(0.4);
  expect(ig.lightPower(() => 1)).toBe(0);
  ig.update(0.2);
  expect(ig.lightPower(() => 0)).toBeCloseTo(0.25);
  expect(ig.lightPower(() => 1)).toBeCloseTo(0.6);
  ig.update(ENGINE_CATCH_S);
  expect(ig.state).toBe('running');
  expect(ig.lightPower(() => 0)).toBe(1);
  ig.stop();
  expect(ig.lightPower(() => 1)).toBe(0);
});
