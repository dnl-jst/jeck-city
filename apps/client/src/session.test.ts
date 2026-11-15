import { expect, test } from 'vitest';
import { NEUTRAL_INPUT, type PlayerInput, type SimEvent, type WorldSim } from '@nn/shared';
import { OfflineSession } from './session';

/** Records the inputs of every step; enough of WorldSim for a session. */
function fakeSim(): { sim: WorldSim; steps: PlayerInput[] } {
  const steps: PlayerInput[] = [];
  const sim = {
    step(inputs: ReadonlyMap<number, PlayerInput>): SimEvent[] {
      steps.push(inputs.get(7)!);
      return [{ t: 'lamp', i: steps.length }];
    },
    setRadio() {},
  } as unknown as WorldSim;
  return { sim, steps };
}

test('offline session steps the sim at 60 Hz', () => {
  const { sim, steps } = fakeSim();
  const s = new OfflineSession(sim, 7);
  const ev = s.frame(0.05, { ...NEUTRAL_INPUT(1), forward: 1 });
  expect(steps).toHaveLength(3);
  expect(s.steps).toBe(3);
  expect(steps.every((i) => i.forward === 1 && i.yaw === 1)).toBe(true);
  expect(ev).toEqual([{ t: 'lamp', i: 1 }, { t: 'lamp', i: 2 }, { t: 'lamp', i: 3 }]);
  expect(s.alpha).toBeCloseTo(0, 6);
  s.frame(0.01, NEUTRAL_INPUT(0));
  expect(steps).toHaveLength(3);
  expect(s.alpha).toBeCloseTo(0.6, 6);
});

test('jump is consumed once', () => {
  const { sim, steps } = fakeSim();
  const s = new OfflineSession(sim, 7);
  // pressed in a frame without a step: held over to the next step, then true for exactly that one step
  s.frame(0.005, { ...NEUTRAL_INPUT(0), jump: true, use: true });
  expect(steps).toHaveLength(0);
  s.frame(0.05, NEUTRAL_INPUT(0));
  expect(steps.map((i) => i.jump)).toEqual([true, false, false]);
  expect(steps.map((i) => i.use)).toEqual([true, false, false]);
  s.frame(0.05, { ...NEUTRAL_INPUT(0), jump: true });
  expect(steps.slice(3).map((i) => i.jump)).toEqual([true, false, false]);
  expect(steps.slice(3).map((i) => i.use)).toEqual([false, false, false]);
});

test('onStep runs after every step', () => {
  const { sim } = fakeSim();
  const s = new OfflineSession(sim, 7);
  const seen: number[] = [];
  s.onStep = () => seen.push(s.steps);
  s.frame(1 / 30, NEUTRAL_INPUT(0));
  expect(seen).toEqual([1, 2]);
});
