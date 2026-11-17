import type { CarPose } from './rules';

type Vec3 = { x: number; y: number; z: number };

/** Half length and half width (m) of the top that counts as on a vehicle. */
export type RoofSize = { halfLength: number; halfWidth: number };
/** A car's roof (generous: the biggest model's body). */
export const CAR_ROOF: RoofSize = { halfLength: 2.6, halfWidth: 1.1 };
/** A bike's top (a cargo bike's box, generous). */
export const BIKE_ROOF: RoofSize = { halfLength: 1.4, halfWidth: 0.5 };
/** Feet at least this far above a car's body origin are on its roof, at most ROOF_ABOVE_MAX (m). */
const ROOF_ABOVE_MIN = 0.3, ROOF_ABOVE_MAX = 1.6;

/** Whether feet at p stand on (or are just above) the top of the vehicle posed at c (a car's roof by default). */
export function onRoof(c: CarPose, p: Vec3, size: RoofSize = CAR_ROOF): boolean {
  const dy = p.y - c.y;
  if (dy < ROOF_ABOVE_MIN || dy > ROOF_ABOVE_MAX) return false;
  const [x, , z] = rotate(conj(c), [p.x - c.x, p.y - c.y, p.z - c.z]);
  return Math.abs(z) < size.halfLength && Math.abs(x) < size.halfWidth;
}

/** A bike's pose (ground under it, heading) as a pose with a rotation (about y only), for onRoof and reanchor. */
export function headingPose(p: { x: number; y: number; z: number; heading: number }): CarPose {
  return { x: p.x, y: p.y, z: p.z, qx: 0, qy: Math.sin(p.heading / 2), qz: 0, qw: Math.cos(p.heading / 2) };
}

/** p in the frame of a car posed at c (its offset from the car, turned back). */
export function toCarLocal(p: Vec3, c: CarPose): Vec3 {
  const [x, y, z] = rotate(conj(c), [p.x - c.x, p.y - c.y, p.z - c.z]);
  return { x, y, z };
}

/** A point given in the frame of a car (toCarLocal) where it is with the car posed at c. */
export function fromCarLocal(l: Vec3, c: CarPose): Vec3 {
  const [x, y, z] = rotate(c, [l.x, l.y, l.z]);
  return { x: c.x + x, y: c.y + y, z: c.z + z };
}

/** The point p, fixed to a car posed at `from`, where it is with the car posed at `to` (to ∘ from⁻¹ ∘ p). */
export function reanchor(p: Vec3, from: CarPose, to: CarPose): Vec3 {
  const local = rotate(conj(from), [p.x - from.x, p.y - from.y, p.z - from.z]);
  const [x, y, z] = rotate({ qx: to.qx, qy: to.qy, qz: to.qz, qw: to.qw }, local);
  return { x: to.x + x, y: to.y + y, z: to.z + z };
}

type Q = { qx: number; qy: number; qz: number; qw: number };
const conj = (q: Q): Q => ({ qx: -q.qx, qy: -q.qy, qz: -q.qz, qw: q.qw });
/** v rotated by the unit quaternion q. */
function rotate(q: Q, v: [number, number, number]): [number, number, number] {
  const [x, y, z] = v;
  const tx = 2 * (q.qy * z - q.qz * y), ty = 2 * (q.qz * x - q.qx * z), tz = 2 * (q.qx * y - q.qy * x);
  return [x + q.qw * tx + (q.qy * tz - q.qz * ty), y + q.qw * ty + (q.qz * tx - q.qx * tz), z + q.qw * tz + (q.qx * ty - q.qy * tx)];
}
