const TWO_PI = Math.PI * 2;
const INV_SQRT2 = Math.SQRT1_2;

/** Metres → centimetres (int32). Non-finite input becomes 0. */
export const qPos = (m: number): number => (Number.isFinite(m) ? Math.round(m * 100) : 0);
export const dqPos = (cm: number): number => cm / 100;

/** Radians → uint16 turn fraction (wraps; non-finite becomes 0). */
export const qAngle = (rad: number): number => {
  if (!Number.isFinite(rad)) return 0;
  const t = ((rad % TWO_PI) + TWO_PI) % TWO_PI;
  return Math.round((t / TWO_PI) * 65536) & 0xffff;
};
/** uint16 → radians in [0, 2π). */
export const dqAngle = (v: number): number => (v / 65536) * TWO_PI;

export type PackedQuat = { a: number; b: number; c: number; idx: 0 | 1 | 2 | 3 };
export type Quat = { x: number; y: number; z: number; w: number };

const clamp16 = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v)));

/** Smallest-three: drops the largest component (index idx, made non-negative by flipping the sign of q). */
export function packQuat(q: Quat): PackedQuat {
  let c = [q.x, q.y, q.z, q.w].map((v) => (Number.isFinite(v) ? v : 0));
  const len = Math.hypot(c[0]!, c[1]!, c[2]!, c[3]!);
  c = len > 1e-9 ? c.map((v) => v / len) : [0, 0, 0, 1];
  let idx = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(c[i]!) > Math.abs(c[idx]!)) idx = i;
  const sign = c[idx]! < 0 ? -1 : 1;
  const rest = c.filter((_, i) => i !== idx).map((v) => clamp16((v * sign * 32767) / INV_SQRT2));
  return { a: rest[0]!, b: rest[1]!, c: rest[2]!, idx: idx as 0 | 1 | 2 | 3 };
}

export function unpackQuat(p: PackedQuat): Quat {
  const r = [p.a, p.b, p.c].map((v) => (v / 32767) * INV_SQRT2);
  const omitted = Math.sqrt(Math.max(0, 1 - r[0]! * r[0]! - r[1]! * r[1]! - r[2]! * r[2]!));
  const out = [0, 0, 0, 0];
  let k = 0;
  for (let i = 0; i < 4; i++) out[i] = i === p.idx ? omitted : r[k++]!;
  return { x: out[0]!, y: out[1]!, z: out[2]!, w: out[3]! };
}

/** m/s → int16 cm/s, clamped to ±327 m/s. */
export const qVel = (mps: number): number =>
  Number.isFinite(mps) ? Math.max(-32700, Math.min(32700, Math.round(mps * 100))) : 0;
export const dqVel = (v: number): number => v / 100;
