import { MIX, type ShotVoice } from './mixer';
import type { SoundId } from './sounds';

/**
 * Bike sounds, synthesised (no recordings): metallic freewheel pawl ticks while coasting and a
 * two-tone bell. Pedalling and rolling are silent. The samples are generated once by the mixer (SYNTH in mixer.ts).
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
 * One freewheel pawl click, crisp with body: a noise burst low-passed at ~5 kHz (0.4 ms decay) and short hub modes at
 * 2.0 / 3.2 / 5.2 kHz (≤ 1.4 ms) – between a bright tick and a woody tock. Nearly all of it is over in 4 ms.
 */
export function synthTick(rate: number): Float32Array {
  const n = Math.round(rate * 0.012);
  const out = new Float32Array(n);
  const r = noise(7);
  const modes: [number, number, number][] = [[3200, 0.5, 0.0011], [2000, 0.35, 0.0014], [5200, 0.3, 0.0008]];
  const k = 1 - Math.exp((-2 * Math.PI * 5000) / rate); // burst low-passed at ~5 kHz
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    lp += (r() - lp) * k;
    let v = lp * 1.4 * Math.exp(-t / 0.0004);
    for (const [f, a, tau] of modes) v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t + 0.9);
    out[i] = v;
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i]! / peak) * 0.95;
  return out;
}

type Out = { oneShot(id: SoundId, o?: { gain?: number; rate?: number }): ShotVoice };

/** The sounds of the ridden bike; start() when getting on, stop() when getting off. */
export class BikeSound {
  private active = false;
  private tickClock = 0;
  private rand = noise(3);

  constructor(private readonly out: Out) {}

  start(): void {
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.tickClock = 0;
  }

  /** Every frame while riding; speed in m/s. */
  update(s: { speed: number; pedalling: boolean; grounded: boolean }, dt: number): void {
    if (!this.active) return;
    const v = Math.abs(s.speed);
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
