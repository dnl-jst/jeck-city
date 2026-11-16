import { describe, expect, test } from 'vitest';
import { BikeSound, freewheelTickRate, synthBell, synthTick } from './bike-sound';
import type { SoundId } from './sounds';

describe('bike sound curves', () => {
  test('freewheel ticks only while rolling without pedalling', () => {
    expect(freewheelTickRate(5, false)).toBeGreaterThan(0);
    expect(freewheelTickRate(5, true)).toBe(0);
    expect(freewheelTickRate(0, false)).toBe(0);
    expect(freewheelTickRate(2, false)).toBeGreaterThan(freewheelTickRate(1, false)); // below the cap
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
  test('tick is crisp but dull: a hard attack, nearly all energy in the first 4 ms, its body around 2–4.5 kHz', () => {
    const rate = 48000;
    const t = synthTick(rate);
    expect(t.length).toBeLessThanOrEqual(rate * 0.015);
    expect(peak(t, 0, 24)).toBeGreaterThan(0.6); // peak within the first half millisecond
    const energy = (from: number, to: number) => t.subarray(from, to).reduce((e, v) => e + v * v, 0);
    expect(energy(0, rate * 0.004) / energy(0, t.length)).toBeGreaterThan(0.85);
    // dull, not shrill: zero crossings in the first 3 ms point at a dominant frequency in the low kHz
    let zc = 0;
    for (let i = 1; i < rate * 0.003; i++) if (Math.sign(t[i]!) !== Math.sign(t[i - 1]!)) zc++;
    const f = zc / 2 / 0.003;
    expect(f).toBeGreaterThan(2000);
    expect(f).toBeLessThan(4500);
  });
  test('freewheel ticks stay below a buzz', () => {
    expect(freewheelTickRate(15, false)).toBeLessThanOrEqual(36);
  });
});

describe('BikeSound', () => {
  const run = (s: BikeSound, st: { speed: number; pedalling: boolean; grounded: boolean }, seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) s.update(st, 1 / 60);
  };

  test('coasting ticks; pedalling, standing and a stopped bike are silent; bell is a one-shot', () => {
    const shots: SoundId[] = [];
    const s = new BikeSound({ oneShot: (id) => (shots.push(id), { stop() {} }) });
    run(s, { speed: 6, pedalling: false, grounded: true }, 1);
    expect(shots).toHaveLength(0); // not started
    s.start();
    run(s, { speed: 6, pedalling: false, grounded: true }, 1);
    expect(shots.filter((i) => i === 'bikeTick').length).toBeGreaterThan(10);
    shots.length = 0;
    run(s, { speed: 6, pedalling: true, grounded: true }, 1);
    run(s, { speed: 0, pedalling: false, grounded: true }, 1);
    expect(shots).toHaveLength(0);
    s.bell();
    expect(shots).toEqual(['bikeBell']);
    s.stop();
    run(s, { speed: 6, pedalling: false, grounded: true }, 1);
    expect(shots).toEqual(['bikeBell']);
  });
});
