/**
 * The underground train, synthesised. Ride: a rolling rumble (wheels on rails in a tunnel: low noise with a slow beat)
 * and the whine of the traction motors (a tone with harmonics; its pitch follows the speed, see trainVoices); both are
 * seamless loops (every partial runs a whole number of cycles). Doors: a puff of air, the leaves sliding and a soft
 * thud; closing starts with three warning beeps.
 */
const ROLL_S = 3, MOTOR_S = 1;

/** Deterministic 0..1 pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Rolling: many low partials with random phases (a rumble around 60–400 Hz), louder twice per loop (rail joints). */
export function synthTrainRoll(rate: number): Float32Array {
  const n = Math.round(rate * ROLL_S), out = new Float32Array(n), r = rng(31);
  const partials: [number, number, number][] = [];
  for (let k = Math.round(35 * ROLL_S); k <= Math.round(900 * ROLL_S); k += 1 + Math.floor(r() * 3)) {
    const f = k / ROLL_S;
    // most of the energy low, a hiss of steel on steel above
    const a = (f < 260 ? 1 / (1 + ((f - 110) / 90) ** 2) : 0.12 / (1 + ((f - 600) / 300) ** 2)) * (0.5 + r());
    partials.push([f, a, r() * 2 * Math.PI]);
  }
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const [f, a, p] of partials) v += a * Math.sin(2 * Math.PI * f * t + p);
    out[i] = v * (0.8 + 0.2 * Math.sin((2 * Math.PI * 2 * t) / ROLL_S) ** 2);
  }
  return normalise(out, 0.8);
}

/** Motors: a 180 Hz tone with harmonics and a slight vibrato (a whole number of vibrato cycles per loop). */
export function synthTrainMotor(rate: number): Float32Array {
  const n = Math.round(rate * MOTOR_S), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate, ph = 2 * Math.PI * 180 * t + 0.25 * Math.sin(2 * Math.PI * 6 * t);
    out[i] = Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.22 * Math.sin(3 * ph) + 0.3 * Math.sin(5 * ph + 1) + 0.12 * Math.sin(8 * ph + 2);
  }
  return normalise(out, 0.6);
}

/**
 * The doors' own sound from `t0` on, added to `out`: a short puff of air, the leaves sliding for `slide` s (a low
 * rumble) and a soft thud when they reach the end.
 */
function doorMove(out: Float32Array, rate: number, t0: number, slide: number, seed: number): void {
  const r = rng(seed);
  let hiss = 0, low = 0, low2 = 0;
  const i0 = Math.round(t0 * rate), n = Math.min(out.length - i0, Math.round((slide + 0.35) * rate));
  for (let i = 0; i < n; i++) {
    const t = i / rate, white = r() * 2 - 1;
    // air: bright noise (white minus its low part), a quick burst that dies away
    hiss += (white - hiss) * 0.25;
    const air = (white - hiss) * Math.exp(-t / 0.09) * (1 - Math.exp(-t / 0.004)) * 0.5;
    // sliding: noise low-passed twice (≈ 300 Hz), fading in and out over the movement
    low += (white - low) * 0.04;
    low2 += (low - low2) * 0.04;
    const move = t < slide ? low2 * 2.2 * Math.sin((Math.PI * t) / slide) ** 0.5 : 0;
    // the end stop: a damped 85 Hz knock
    const k = t - slide, knock = k > 0 ? Math.sin(2 * Math.PI * 85 * k) * Math.exp(-k / 0.045) * 0.9 : 0;
    out[i0 + i]! += air + move + knock;
  }
}

/** Doors opening: 1.5 s. */
export function synthTrainDoorOpen(rate: number): Float32Array {
  const out = new Float32Array(Math.round(rate * 1.5));
  doorMove(out, rate, 0, 1.1, 77);
  return normalise(out, 0.7);
}

/** Doors closing: three short warning beeps (two tones, soft edges), then the doors; 2.4 s. */
export function synthTrainDoorClose(rate: number): Float32Array {
  const out = new Float32Array(Math.round(rate * 2.4));
  for (let b = 0; b < 3; b++) {
    const t0 = b * 0.26, len = 0.14, i0 = Math.round(t0 * rate), n = Math.round(len * rate);
    for (let i = 0; i < n; i++) {
      const t = i / rate, env = Math.min(1, t / 0.01, (len - t) / 0.02);
      out[i0 + i]! += (Math.sin(2 * Math.PI * 1320 * t) + 0.4 * Math.sin(2 * Math.PI * 1980 * t)) * env * 0.22;
    }
  }
  doorMove(out, rate, 0.9, 1.1, 91);
  return normalise(out, 0.7);
}

function normalise(a: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const v of a) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < a.length; i++) a[i] = (a[i]! / max) * peak;
  return a;
}

/** Top speed the sound is tuned to (m/s; the trains' 60 km/h). */
const VMAX = 60 / 3.6;

/**
 * Loop gains (0..1, before the mix level) and playback rates for a train `dist` m away running at `speed` m/s;
 * `inside`: the listener rides in it.
 */
export function trainVoices(dist: number, speed: number, inside: boolean): { roll: number; rollRate: number; motor: number; motorRate: number } {
  const v = Math.min(1, Math.abs(speed) / VMAX);
  const near = inside ? 1 : 1 / (1 + (dist / 14) ** 2);
  return {
    roll: near * Math.min(1, v * 1.6) * (inside ? 0.75 : 1), rollRate: 0.7 + 0.5 * v,
    // the motors are heard while it moves; highest when fast
    motor: near * Math.min(1, v * 4) * (0.35 + 0.3 * v) * (inside ? 0.8 : 1), motorRate: 0.45 + 1.5 * v,
  };
}
