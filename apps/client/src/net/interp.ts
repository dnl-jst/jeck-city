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

/** CatchUp: a rendered step this much (m) beyond what the entity's recent speed explains is a catch-up, not motion. */
export const CATCHUP_MIN_M = 0.3;
/** A catch-up is spread over this long (s), linearly. */
export const CATCHUP_BLEND_S = 0.15;
/** Farther than this (m) is a teleport or a respawn: drawn there at once. */
export const CATCHUP_SNAP_M = 20;

type Quat = { x: number; y: number; z: number; w: number };
type V3 = { x: number; y: number; z: number };
type CatchUpState = {
  raw: V3;
  /** Raw velocity (m/s) from the last two frames: the motion the next frame is expected to show. */
  vel: V3;
  /** Offset (drawn − raw) when the running blend started (ms: since), for position, rotation (q · raw) and angle. */
  off: V3;
  offQ: Quat | null;
  offA: number;
  since: number;
  /** Last frame: when (ms), and the drawn rotation and angle. */
  t: number;
  q: Quat | null;
  a: number;
};

const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
/** nlerp from identity to q by t (the short way). */
const towards = (q: Quat, t: number): Quat => {
  const s = q.w < 0 ? -1 : 1;
  const x = s * q.x * t, y = s * q.y * t, z = s * q.z * t, w = 1 + (s * q.w - 1) * t;
  const n = Math.hypot(x, y, z, w) || 1;
  return { x: x / n, y: y / n, z: z / n, w: w / n };
};
const quatOf = (p: PoseLike): Quat | null => (p.qw === undefined ? null : { x: p.qx!, y: p.qy!, z: p.qz!, w: p.qw });
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const ZERO = (): V3 => ({ x: 0, y: 0, z: 0 });

/**
 * Smooths the drawn remote poses where the sample catches up. After a freeze (past the extrapolation limit), a long
 * frame or a late snapshot, the sampled pose can land metres ahead of the last drawn one. Each frame the sample's step
 * is compared with what the entity's speed over the last two frames explains; a surplus above CATCHUP_MIN_M becomes an
 * offset (the drawn pose goes on from where it was) that shrinks linearly to 0 over CATCHUP_BLEND_S. Position, the
 * quaternion (cars) and an angle field (`angle`, e.g. a rider's heading) are smoothed. Entities that vanish are
 * forgotten; a step beyond CATCHUP_SNAP_M (teleport, respawn) is drawn at once.
 */
export class CatchUp<T extends PoseLike> {
  private readonly st = new Map<string, CatchUpState>();

  constructor(private readonly angle?: keyof T & string) {}

  apply(sampled: ReadonlyMap<string, T>, nowMs: number): Map<string, T> {
    const out = new Map<string, T>();
    for (const [k, raw] of sampled) {
      const a = this.angle ? (raw[this.angle] as unknown as number) : 0;
      const s = this.st.get(k);
      if (!s) {
        this.st.set(k, { raw: { x: raw.x, y: raw.y, z: raw.z }, vel: ZERO(), off: ZERO(), offQ: null, offA: 0, since: -Infinity, t: nowMs, q: quatOf(raw), a });
        out.set(k, raw);
        continue;
      }
      const dt = Math.max(0, (nowMs - s.t) / 1000);
      const d = { x: raw.x - s.raw.x, y: raw.y - s.raw.y, z: raw.z - s.raw.z };
      const jump = { x: d.x - s.vel.x * dt, y: d.y - s.vel.y * dt, z: d.z - s.vel.z * dt };
      const size = Math.hypot(jump.x, jump.y, jump.z);
      if (size > CATCHUP_SNAP_M) {
        Object.assign(s, { vel: ZERO(), off: ZERO(), offQ: null, offA: 0, since: -Infinity });
      } else if (size > CATCHUP_MIN_M) {
        // what is left of the running blend, plus the new surplus; the expected motion stays the one from before
        const left = this.left(s, nowMs);
        s.off = { x: left * s.off.x - jump.x, y: left * s.off.y - jump.y, z: left * s.off.z - jump.z };
        const q = quatOf(raw);
        s.offQ = q && s.q ? qmul(s.q, { x: -q.x, y: -q.y, z: -q.z, w: q.w }) : null;
        s.offA = wrap(s.a - a);
        s.since = nowMs;
      } else if (dt > 0) {
        s.vel = { x: d.x / dt, y: d.y / dt, z: d.z / dt };
      }
      s.raw = { x: raw.x, y: raw.y, z: raw.z };
      s.t = nowMs;
      out.set(k, this.compose(raw, s, this.left(s, nowMs), a));
    }
    for (const k of [...this.st.keys()]) if (!sampled.has(k)) this.st.delete(k);
    return out;
  }

  clear(): void {
    this.st.clear();
  }

  /** Fraction of the blend's start offset still applied at nowMs (1 → 0 over CATCHUP_BLEND_S). */
  private left(s: CatchUpState, nowMs: number): number {
    return Math.max(0, 1 - (nowMs - s.since) / (CATCHUP_BLEND_S * 1000));
  }

  private compose(raw: T, s: CatchUpState, left: number, a: number): T {
    const q = quatOf(raw);
    if (left <= 0) {
      s.q = q;
      s.a = a;
      return raw;
    }
    const out: T = { ...raw, x: raw.x + s.off.x * left, y: raw.y + s.off.y * left, z: raw.z + s.off.z * left };
    if (q) {
      const r = s.offQ ? qmul(towards(s.offQ, left), q) : q;
      out.qx = r.x; out.qy = r.y; out.qz = r.z; out.qw = r.w;
      s.q = r;
    }
    s.a = a + s.offA * left;
    if (this.angle) (out as Record<string, unknown>)[this.angle] = s.a;
    return out;
  }
}
