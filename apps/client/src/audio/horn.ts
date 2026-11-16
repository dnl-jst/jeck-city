/**
 * Car horn, synthesised: a two-tone electric fanfare (low ≈ 410 Hz, high ≈ 510 Hz, roughly a major third like the
 * usual Bosch pair). Each horn is a buzzing diaphragm (rich harmonic series) shaped by the trumpet's resonance around
 * 2.4 kHz, the two summed and gently saturated. Played as a loop while H is held in a car.
 */

/** Fundamental frequencies (Hz) of the low and high horn; whole numbers so a 1 s loop is seamless. */
export const HORN_TONES = [410, 510] as const;
/** Trumpet resonance (Hz) and its width. */
const FORMANT = 2400;
const FORMANT_WIDTH = 900;

/** Seamless 1 s horn loop (every partial completes whole cycles), peak-normalised to 0.9. */
export function synthHorn(rate: number): Float32Array {
  const n = Math.round(rate);
  const out = new Float32Array(n);
  const partials: [number, number, number][] = []; // frequency, amplitude, phase
  let seed = 11;
  for (const [h, f0] of HORN_TONES.entries()) {
    for (let k = 1; f0 * k < Math.min(9000, rate / 2 - 500); k++) {
      const f = f0 * k;
      const res = 1 + 2.5 * Math.exp(-(((f - FORMANT) / FORMANT_WIDTH) ** 2));
      seed = (seed * 16807) % 2147483647;
      partials.push([f, (h === 0 ? 1 : 0.85) * (res / k ** 0.9), (seed / 2147483647) * 2 * Math.PI]);
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const [f, a, p] of partials) v += a * Math.sin(2 * Math.PI * f * t + p);
    out[i] = v;
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  // a little saturation for the rasp of a real horn
  for (let i = 0; i < n; i++) out[i] = Math.tanh((out[i]! / peak) * 1.8);
  const peak2 = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i]! / peak2) * 0.9;
  return out;
}

/** A horn tap still sounds this long (s), so a quick press is a short "tööt", not a click. */
export const HORN_MIN = 0.18;

/** Hold-to-honk: decides each frame whether the horn sounds. */
export class HornState {
  private left = 0;

  /** `held`: H down (or pressed since the last frame). Returns whether the horn sounds now. */
  update(held: boolean, dt: number): boolean {
    if (held) this.left = HORN_MIN;
    else this.left = Math.max(0, this.left - dt);
    return held || this.left > 0;
  }

  reset(): void {
    this.left = 0;
  }
}
