import { describe, expect, test } from 'vitest';
import { BikeSound, freewheelTickRate, rollGain, synthBell, synthNoiseLoop, synthTick } from './bike-sound';
import type { LoopVoice } from './mixer';
import type { SoundId } from './sounds';

describe('bike sound curves', () => {
  test('freewheel ticks only while rolling without pedalling', () => {
    expect(freewheelTickRate(5, false)).toBeGreaterThan(0);
    expect(freewheelTickRate(5, true)).toBe(0);
    expect(freewheelTickRate(0, false)).toBe(0);
    expect(freewheelTickRate(2, false)).toBeGreaterThan(freewheelTickRate(1, false)); // below the cap
  });

  test('rolling noise rises with speed up to 40 km/h', () => {
    expect(rollGain(0)).toBe(0);
    expect(rollGain(40 / 3.6)).toBeCloseTo(1, 9);
    expect(rollGain(60 / 3.6)).toBe(1);
    expect(rollGain(10 / 3.6)).toBeLessThan(rollGain(20 / 3.6));
  });
});

describe('synthesised samples', () => {
  const peak = (a: Float32Array, from = 0, to = a.length) => a.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  test('bell rings and decays', () => {
    const b = synthBell(48000);
    expect(b.length).toBeGreaterThan(48000);
    const early = peak(b, 0, 4800), late = peak(b, b.length - 4800);
    expect(early).toBeGreaterThan(0.3);
    expect(early).toBeLessThanOrEqual(1);
    expect(late).toBeLessThan(early * 0.2);
  });
  test('tick is a short metallic click: rings in the 3–7 kHz band, gone within 30 ms', () => {
    const t = synthTick(48000);
    expect(t.length).toBeLessThan(48000 * 0.03);
    expect(peak(t, 0, 48)).toBeGreaterThan(0.3);
    expect(peak(t, t.length - 48)).toBeLessThan(0.02);
    // zero crossings in the first 5 ms ≈ 2 × dominant frequency × 5 ms
    let zc = 0;
    for (let i = 1; i < 240; i++) if (Math.sign(t[i]!) !== Math.sign(t[i - 1]!)) zc++;
    const f = zc / 2 / 0.005;
    expect(f).toBeGreaterThan(2500);
    expect(f).toBeLessThan(8000);
  });
  test('freewheel ticks stay below a buzz', () => {
    expect(freewheelTickRate(15, false)).toBeLessThanOrEqual(36);
  });
  test('loops are seamless', () => {
    const loop = synthNoiseLoop(48000, 1, 800);
    // the jump across the loop point is no bigger than any step inside the loop (no click)
    let maxStep = 0;
    for (let i = 1; i < loop.length; i++) maxStep = Math.max(maxStep, Math.abs(loop[i]! - loop[i - 1]!));
    expect(Math.abs(loop[0]! - loop[loop.length - 1]!)).toBeLessThanOrEqual(maxStep);
  });
});

describe('BikeSound', () => {
  function fake() {
    const loops = new Map<SoundId, { gain: number; rate: number; stopped: boolean }>();
    const shots: SoundId[] = [];
    const out = {
      loop(id: SoundId): LoopVoice {
        const v = { gain: 0, rate: 1, stopped: false };
        loops.set(id, v);
        return { setGain: (g) => { v.gain = g; }, setRate: (r) => { v.rate = r; }, stop: () => { v.stopped = true; } };
      },
      oneShot(id: SoundId) {
        shots.push(id);
        return { stop() {} };
      },
    };
    return { out, loops, shots };
  }
  const run = (s: BikeSound, st: { speed: number; pedalling: boolean; grounded: boolean }, seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) s.update(st, 1 / 60);
  };

  test('coasting ticks, pedalling plays the chain instead', () => {
    const { out, loops, shots } = fake();
    const s = new BikeSound(out);
    s.start();
    run(s, { speed: 6, pedalling: false, grounded: true }, 1);
    expect(shots.filter((i) => i === 'bikeTick').length).toBeGreaterThan(10);
    expect(loops.get('bikeChain')!.gain).toBeLessThan(0.01);
    shots.length = 0;
    run(s, { speed: 6, pedalling: true, grounded: true }, 1);
    expect(shots.filter((i) => i === 'bikeTick')).toHaveLength(0);
    expect(loops.get('bikeChain')!.gain).toBeGreaterThan(0.05);
    expect(loops.get('bikeRoll')!.gain).toBeGreaterThan(0.05);
  });

  test('no rolling sound in the air; stop ends the loops; bell is a one-shot', () => {
    const { out, loops, shots } = fake();
    const s = new BikeSound(out);
    s.start();
    run(s, { speed: 6, pedalling: false, grounded: false }, 0.5);
    expect(loops.get('bikeRoll')!.gain).toBeLessThan(0.01);
    s.bell();
    expect(shots).toContain('bikeBell');
    s.stop();
    expect(loops.get('bikeRoll')!.stopped).toBe(true);
  });
});
