import { MIX, type LoopVoice, type ShotVoice } from './mixer';
import type { SoundId } from './sounds';

/**
 * Bike sounds, synthesised (no recordings): freewheel pawl ticks while coasting, a chain whirr while pedalling, tyre
 * rolling noise and a two-tone bell. The samples are generated once by the mixer (SYNTH in mixer.ts).
 */

/** Freewheel ticks per second: ~12 per wheel turn-equivalent metre, only while rolling without pedalling. */
export function freewheelTickRate(speed: number, pedalling: boolean): number {
  if (pedalling || speed < 0.3) return 0;
  return Math.min(60, speed * 12);
}

/** Rolling noise gain 0..1: square-root curve, full at 40 km/h. */
export function rollGain(speed: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, speed) / (40 / 3.6)));
}

/** Deterministic noise in −1..1 (so samples are the same every run). */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Bike bell: two inharmonic partials (≈ 2.8 and 4.1 kHz), struck twice, 1.2 s decay. */
export function synthBell(rate: number): Float32Array {
  const out = new Float32Array(Math.round(rate * 1.6));
  const strikes = [0, 0.14];
  const partials: [number, number][] = [[2800, 0.6], [4100, 0.3], [6900, 0.1]];
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let v = 0;
    for (const s of strikes) {
      const u = t - s;
      if (u < 0) continue;
      const env = Math.exp(-u / 0.35) * Math.min(1, u * 800);
      for (const [f, a] of partials) v += a * env * Math.sin(2 * Math.PI * f * u);
    }
    out[i] = v * 0.8;
  }
  return out;
}

/** One freewheel pawl click: a few milliseconds of band-limited noise. */
export function synthTick(rate: number): Float32Array {
  const n = Math.round(rate * 0.012);
  const out = new Float32Array(n);
  const r = noise(7);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const x = r();
    lp += (x - lp) * 0.5;
    out[i] = (x - lp) * Math.exp(-i / (rate * 0.002));
  }
  return out;
}

/** Seamless noise loop (seconds long), low-passed at about `cutoff` Hz; ends fade into each other. */
export function synthNoiseLoop(rate: number, seconds: number, cutoff: number): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  const r = noise(cutoff | 0);
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += (r() - lp) * k;
    out[i] = lp;
  }
  // the loop is the first n − fade samples, its start crossfaded with what follows its end: no click at the seam
  const fade = Math.round(n * 0.1);
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = out[i]! * w + out[n - fade + i]! * (1 - w);
  }
  const loop = out.slice(0, n - fade);
  const peak = loop.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  for (let i = 0; i < loop.length; i++) loop[i] = loop[i]! / peak;
  return loop;
}

type Out = { loop(id: SoundId): LoopVoice; oneShot(id: SoundId, o?: { gain?: number; rate?: number }): ShotVoice };

/** The sounds of the ridden bike; start() when getting on, stop() when getting off. */
export class BikeSound {
  private roll: LoopVoice | null = null;
  private chain: LoopVoice | null = null;
  private tickClock = 0;
  private rand = noise(3);

  constructor(private readonly out: Out) {}

  start(): void {
    if (this.roll) return;
    this.roll = this.out.loop('bikeRoll');
    this.chain = this.out.loop('bikeChain');
    this.roll.setGain(0);
    this.chain.setGain(0);
  }

  stop(): void {
    this.roll?.stop();
    this.chain?.stop();
    this.roll = this.chain = null;
  }

  /** Every frame while riding; speed in m/s. */
  update(s: { speed: number; pedalling: boolean; grounded: boolean }, dt: number): void {
    if (!this.roll || !this.chain) return;
    const v = Math.abs(s.speed);
    this.roll.setGain(s.grounded ? rollGain(v) * MIX.bikeRoll : 0);
    this.roll.setRate(0.8 + 0.5 * Math.min(1, v / 12));
    this.chain.setGain(s.pedalling ? MIX.bikeChain * Math.min(1, 0.4 + v / 8) : 0);
    this.chain.setRate(0.7 + 0.6 * Math.min(1, v / 10));
    const rate = freewheelTickRate(v, s.pedalling);
    if (rate <= 0) {
      this.tickClock = 0;
      return;
    }
    this.tickClock += rate * dt;
    while (this.tickClock >= 1) {
      this.tickClock -= 1;
      this.out.oneShot('bikeTick', { gain: MIX.bikeTick, rate: 0.9 + 0.2 * Math.abs(this.rand()) });
    }
  }

  bell(): void {
    this.out.oneShot('bikeBell', { gain: MIX.bikeBell });
  }
}
