/**
 * Helicopter rotor, synthesised: the blades' chop (18 blade passes a second: a low thump with a burst of air each)
 * over a faint turbine whine. A seamless 1 s loop; GameAudio plays it slower and quieter while the rotor spools up.
 */

/** Blade passes per second at full rotor speed (a whole number, so the 1 s loop is seamless). */
export const ROTOR_BLADE_HZ = 18;

export function synthRotor(rate: number): Float32Array {
  const n = Math.round(rate);
  // looping noise, low-passed twice round the loop so its end runs into its start
  const noise = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    noise[i] = (seed / 2147483647) * 2 - 1;
  }
  const air = new Float32Array(n);
  let lp = 0;
  const k = 1 - Math.exp((-2 * Math.PI * 900) / rate);
  for (let i = 0; i < 2 * n; i++) {
    lp += (noise[i % n]! - lp) * k;
    air[i % n] = lp;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = (t * ROTOR_BLADE_HZ) % 1;
    const thump = Math.exp(-phase * 5) * Math.min(1, phase * 40); // sharp attack, decays until the next blade
    out[i] = thump * (0.9 * Math.sin(2 * Math.PI * 72 * t) + 0.45 * Math.sin(2 * Math.PI * 144 * t) + 2.2 * air[i]!)
      + 0.5 * air[i]! + 0.03 * Math.sin(2 * Math.PI * 2100 * t) + 0.02 * Math.sin(2 * Math.PI * 3150 * t);
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i]! / peak) * 0.9;
  return out;
}
