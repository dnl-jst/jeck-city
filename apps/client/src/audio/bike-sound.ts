import { MIX, type LoopVoice, type ShotVoice } from './mixer';
import type { SoundId } from './sounds';

/**
 * Bike sounds, synthesised (no recordings): metallic freewheel pawl ticks while coasting, a chain whirr while pedalling, tyre
 * rolling noise and a two-tone bell. The samples are generated once by the mixer (SYNTH in mixer.ts).
 */

/** Pawl engagements per wheel turn (a typical rear hub) and the wheel circumference (m). */
const ENGAGEMENTS = 24;
const WHEEL_CIRCUMFERENCE = 2.2;
/** Above this many ticks per second the clicks would blur into noise: the rate stays here and only quietens. */
const MAX_TICKS = 34;

/** Freewheel ticks per second while rolling without pedalling (0 when pedalling or standing), capped at MAX_TICKS. */
export function freewheelTickRate(speed: number, pedalling: boolean): number {
  if (pedalling || speed < 0.3) return 0;
  return Math.min(MAX_TICKS, (speed / WHEEL_CIRCUMFERENCE) * ENGAGEMENTS);
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

/**
 * One freewheel pawl click: a hard transient, then the hub shell ringing briefly at a few inharmonic metallic modes
 * (3.3 / 4.9 / 6.6 kHz) – a bright, dry "tick" rather than a noise burst.
 */
export function synthTick(rate: number): Float32Array {
  const n = Math.round(rate * 0.022);
  const out = new Float32Array(n);
  const r = noise(7);
  const modes: [number, number, number][] = [[3300, 0.55, 0.0045], [4900, 0.3, 0.003], [6600, 0.15, 0.002]];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = r() * 0.5 * Math.exp(-t / 0.0003); // the pawl hitting the tooth
    for (const [f, a, tau] of modes) v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t);
    out[i] = v * Math.min(1, i / 4); // no step at the very start
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i]! / peak) * 0.8;
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
    // at the cap the clicks get softer with more speed, so a fast roll is a fine whirr, not a rattle
    const soft = v > 0 ? Math.min(1, (MAX_TICKS * WHEEL_CIRCUMFERENCE) / ENGAGEMENTS / v) : 1;
    while (this.tickClock >= 1) {
      // a little jitter in timing and pitch, like real pawls
      this.tickClock -= 1 + 0.12 * this.rand();
      this.out.oneShot('bikeTick', { gain: MIX.bikeTick * (0.75 + 0.25 * soft), rate: 0.94 + 0.12 * Math.abs(this.rand()) });
    }
  }

  bell(): void {
    this.out.oneShot('bikeBell', { gain: MIX.bikeBell });
  }
}
