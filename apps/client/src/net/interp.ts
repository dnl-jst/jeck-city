import { EXTRAPOLATE_MAX_S, TICK_HZ } from '@nn/shared';

/** How to blend two states of one entity and how to carry one forward in time. */
export interface InterpOps<T> {
  /** t in 0..1 from a to b. */
  lerp(a: T, b: T, t: number): T;
  /** The state `dtS` seconds after a (dtS is already limited to EXTRAPOLATE_MAX_S). */
  extrapolate(a: T, dtS: number): T;
}

type Snap<T> = { tick: number; entities: Map<string, T> };
const KEEP = 40;

/**
 * Remote entities as the server sent them (20 Hz), sampled at an arbitrary render tick.
 * Between two snapshots: interpolate. Past the newest: extrapolate with the velocity up to EXTRAPOLATE_MAX_S, then
 * freeze. An entity that is missing from the newer of two snapshots stays at its last pose until that snapshot's tick,
 * then disappears. An entity that is new in a snapshot appears at that snapshot's tick.
 */
export class SnapshotBuffer<T> {
  private snaps: Snap<T>[] = [];

  constructor(private readonly ops: InterpOps<T>) {}

  get newestTick(): number {
    return this.snaps.length ? this.snaps[this.snaps.length - 1]!.tick : -1;
  }

  /** Out-of-order or repeated ticks are ignored. */
  push(serverTick: number, entities: Map<string, T>): void {
    if (serverTick <= this.newestTick) return;
    this.snaps.push({ tick: serverTick, entities });
    if (this.snaps.length > KEEP) this.snaps.shift();
  }

  clear(): void {
    this.snaps = [];
  }

  sample(renderTick: number): Map<string, T> {
    const s = this.snaps;
    const out = new Map<string, T>();
    if (!s.length) return out;
    const last = s[s.length - 1]!;
    if (renderTick >= last.tick) {
      const dt = Math.min((renderTick - last.tick) / TICK_HZ, EXTRAPOLATE_MAX_S);
      for (const [k, v] of last.entities) out.set(k, dt > 0 ? this.ops.extrapolate(v, dt) : v);
      return out;
    }
    if (renderTick <= s[0]!.tick) return new Map(s[0]!.entities);
    let i = s.length - 2;
    while (s[i]!.tick > renderTick) i--;
    const a = s[i]!, b = s[i + 1]!;
    const t = (renderTick - a.tick) / (b.tick - a.tick);
    for (const [k, va] of a.entities) {
      const vb = b.entities.get(k);
      if (vb) out.set(k, this.ops.lerp(va, vb, t));
      else out.set(k, va); // gone in b: held until b's tick (renderTick < b.tick here)
    }
    return out;
  }
}

/** Anything with a position; velocity and a quaternion are optional. */
export type PoseLike = {
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  qx?: number; qy?: number; qz?: number; qw?: number;
};

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Position linear; quaternion nlerp along the short way; every other field comes from the nearer snapshot. */
export function lerpPose<T extends PoseLike>(a: T, b: T, t: number): T {
  const out: T = { ...(t < 0.5 ? a : b), x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) };
  if (a.vx !== undefined && b.vx !== undefined) {
    out.vx = mix(a.vx, b.vx, t); out.vy = mix(a.vy!, b.vy!, t); out.vz = mix(a.vz!, b.vz!, t);
  }
  if (a.qw !== undefined && b.qw !== undefined) {
    const dot = a.qx! * b.qx! + a.qy! * b.qy! + a.qz! * b.qz! + a.qw * b.qw;
    const s = dot < 0 ? -1 : 1;
    let qx = mix(a.qx!, s * b.qx!, t), qy = mix(a.qy!, s * b.qy!, t), qz = mix(a.qz!, s * b.qz!, t), qw = mix(a.qw, s * b.qw, t);
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= n; qy /= n; qz /= n; qw /= n;
    out.qx = qx; out.qy = qy; out.qz = qz; out.qw = qw;
  }
  return out;
}

/** Position carried on with the velocity (no velocity: stays where it is). */
export function extrapolatePose<T extends PoseLike>(a: T, dtS: number): T {
  if (a.vx === undefined) return a;
  return { ...a, x: a.x + a.vx * dtS, y: a.y + a.vy! * dtS, z: a.z + a.vz! * dtS };
}

export const poseOps = <T extends PoseLike>(): InterpOps<T> => ({ lerp: lerpPose, extrapolate: extrapolatePose });

/** Shortest-way blend of two headings (rad). */
const mixAngle = (a: number, b: number, t: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

type Headed = { x: number; y: number; z: number; heading: number };

/** Unridden moving bikes: position linear, heading the short way round; past the newest snapshot they stay. */
export const bikeOps = <T extends Headed>(): InterpOps<T> => ({
  lerp: (a, b, t) => ({ ...a, x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t), heading: mixAngle(a.heading, b.heading, t) }),
  extrapolate: (a) => a,
});

/** Riders: as bikes, plus speed and steering blended; carried on along the heading at their speed. */
export const riderOps = <T extends Headed & { speed: number; steer: number }>(): InterpOps<T> => ({
  lerp: (a, b, t) => ({
    ...(t < 0.5 ? a : b), x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t), heading: mixAngle(a.heading, b.heading, t),
    speed: mix(a.speed, b.speed, t), steer: mix(a.steer, b.steer, t),
  }),
  extrapolate: (a, dtS) => ({ ...a, x: a.x + Math.sin(a.heading) * a.speed * dtS, z: a.z + Math.cos(a.heading) * a.speed * dtS }),
});
