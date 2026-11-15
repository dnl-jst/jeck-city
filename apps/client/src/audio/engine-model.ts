export const IDLE_RPM = 800;
export const GEAR1_TOP_RPM = 3000;
export const SHIFT_LOW_RPM = 1500;
export const CRUISE_TOP_RPM = 3200;
export const REV_IN_PLACE_RPM = 1800;
/** Upper speed bound per gear; the top speed (60) is TUNING.vehicle.maxForwardKmh. */
export const GEAR_TOP_KMH = [20, 35, 50, Infinity];
const TOP_KMH = 60;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Target gear and rpm for a speed magnitude (km/h) and throttle input. */
export function engineTarget(
  kmh: number,
  throttle: number,
): { gear: number; rpm: number } {
  const found = GEAR_TOP_KMH.findIndex((top) => kmh < top);
  const gear = found < 0 ? GEAR_TOP_KMH.length - 1 : found;
  const lo = gear === 0 ? 0 : (GEAR_TOP_KMH[gear - 1] ?? 0);
  const top =
    gear === GEAR_TOP_KMH.length - 1
      ? TOP_KMH
      : (GEAR_TOP_KMH[gear] ?? TOP_KMH);
  const f = clamp((kmh - lo) / (top - lo), 0, 1);
  let rpm =
    gear === 0
      ? IDLE_RPM + f * (GEAR1_TOP_RPM - IDLE_RPM)
      : SHIFT_LOW_RPM + f * (CRUISE_TOP_RPM - SHIFT_LOW_RPM);
  if (kmh < 2 && throttle !== 0) rpm = Math.max(rpm, REV_IN_PLACE_RPM);
  if (throttle === 0) rpm = Math.max(IDLE_RPM, rpm * 0.85);
  return { gear, rpm };
}

/** Exponential approach: 0.12 s time constant rising, 0.25 s falling. */
export function smoothRpm(current: number, target: number, dt: number): number {
  const tau = target > current ? 0.12 : 0.25;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Equal-power crossfade between the two loops bracketing rpm; ascending loops. */
export function engineMix(
  rpm: number,
  loops: { rpm: number }[],
): { gain: number; rate: number }[] {
  const gains = loops.map(() => 0);
  const n = loops.length;
  if (n > 0) {
    const first = loops[0]!.rpm;
    const last = loops[n - 1]!.rpm;
    if (rpm <= first) gains[0] = 1;
    else if (rpm >= last) gains[n - 1] = 1;
    else {
      let i = 0;
      while (loops[i + 1]!.rpm < rpm) i++;
      const a = loops[i]!.rpm;
      const b = loops[i + 1]!.rpm;
      const t = (rpm - a) / (b - a);
      gains[i] = Math.cos((t * Math.PI) / 2);
      gains[i + 1] = Math.sin((t * Math.PI) / 2);
    }
  }
  return loops.map((l, i) => ({
    gain: gains[i]!,
    rate: clamp(rpm / l.rpm, 0.5, 2.0),
  }));
}
