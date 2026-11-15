import { expect, test } from 'vitest';
import { IDLE_RPM } from './engine-model';
import type { LoopVoice } from './mixer';
import { ENGINE_LOOPS, SOUNDS, type SoundId } from './sounds';
import { VehicleSound } from './vehicle-sound';

interface FakeVoice extends LoopVoice {
  gain: number;
  rate: number;
  stopped: boolean;
}

function fakeOut(): { out: { loop(id: SoundId): LoopVoice }; voices: Map<SoundId, FakeVoice> } {
  const voices = new Map<SoundId, FakeVoice>();
  const out = {
    loop(id: SoundId): LoopVoice {
      const v: FakeVoice = {
        gain: 0,
        rate: 1,
        stopped: false,
        setGain(g) { v.gain = g; },
        setRate(r) { v.rate = r; },
        stop() { v.stopped = true; },
      };
      voices.set(id, v);
      return v;
    },
  };
  return { out, voices };
}

function run(vs: VehicleSound, s: { speed: number; throttle: number; skid: number }, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) vs.update(s, 1 / 60);
}

test('idle after start', () => {
  const { out, voices } = fakeOut();
  const vs = new VehicleSound(out);
  vs.start();
  run(vs, { speed: 0, throttle: 0, skid: 0 }, 1);
  const lowest = voices.get(ENGINE_LOOPS[0]!)!;
  const expected = Math.min(2, Math.max(0.5, IDLE_RPM / SOUNDS[ENGINE_LOOPS[0]!].rpm!));
  expect(lowest.gain).toBeGreaterThan(0);
  expect(lowest.rate).toBeCloseTo(expected, 2);
});

test('revs up with speed', () => {
  const { out, voices } = fakeOut();
  const vs = new VehicleSound(out);
  vs.start();
  run(vs, { speed: 16, throttle: 1, skid: 0 }, 3);
  const gains = ENGINE_LOOPS.map((id) => voices.get(id)!.gain);
  expect(gains[0]).toBeCloseTo(0, 3);
  expect(gains.slice(1).some((g) => g > 0.1)).toBe(true);
});

test('reverse speed revs up like forward speed', () => {
  const fwd = fakeOut();
  const rev = fakeOut();
  const a = new VehicleSound(fwd.out);
  const b = new VehicleSound(rev.out);
  a.start();
  b.start();
  run(a, { speed: 5, throttle: 1, skid: 0 }, 2);
  run(b, { speed: -5, throttle: -1, skid: 0 }, 2);
  for (const id of ENGINE_LOOPS) expect(rev.voices.get(id)!.gain).toBeCloseTo(fwd.voices.get(id)!.gain, 5);
});

test('skid voice follows skid', () => {
  const { out, voices } = fakeOut();
  const vs = new VehicleSound(out);
  vs.start();
  vs.update({ speed: 10, throttle: 1, skid: 1 }, 1 / 60);
  expect(voices.get('skid')!.gain).toBeCloseTo(0.6, 5);
  expect(voices.get('skid')!.rate).toBeCloseTo(1.1, 5);
  vs.update({ speed: 10, throttle: 1, skid: 0 }, 1 / 60);
  expect(voices.get('skid')!.gain).toBe(0);
});

test('stop silences all voices', () => {
  const { out, voices } = fakeOut();
  const vs = new VehicleSound(out);
  vs.start();
  vs.stop();
  expect(voices.size).toBe(ENGINE_LOOPS.length + 1);
  for (const v of voices.values()) expect(v.stopped).toBe(true);
});
