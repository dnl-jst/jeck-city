import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { TUNING, type PhysicsWorld } from '@nn/shared';

type Vec3 = { x: number; y: number; z: number };

/** Ragdoll spin (rad/s per m/s of throw, at most SPIN_MAX): over the handlebar head first; hit by a car, legs swept away. */
export const CRASH_SPIN = 0.5, KNOCK_SPIN = -0.3;
const SPIN_MAX = 6;
/** Thrown over the handlebar: the body keeps the bike's velocity and gets this much upwards (m/s). */
export const CRASH_RAG_UP = 2.2;
/** Spin for a throw at v: `perMs` × horizontal speed, capped either way. */
export function ragSpin(v: Vec3, perMs: number): number {
  return Math.max(-SPIN_MAX, Math.min(SPIN_MAX, perMs * Math.hypot(v.x, v.z)));
}

/** Fixed step of the ragdoll world (s) and the most steps one frame may take (a long frame just slows the tumble). */
const STEP = 1 / 60;
const MAX_STEPS = 4;
/** Side (m) of the cells the static surroundings are copied in, and the overlap of a cell's copy into its neighbours. */
const CELL = 12;
const MARGIN = 1;
/** Copied surroundings unused this long (s) are dropped again. */
const KEEP_S = 20;
/** Membership bit 5 (ragdoll parts); filter: the city (bit 0), street furniture (bit 1) and cars (bit 2), never each other. */
const PART_GROUPS = 0x0020_0007;
/** Copied cars: bit 2, colliding with ragdoll parts only. */
const CAR_COPY_GROUPS = 0x0004_0020;
/** Membership bits of the source world's colliders: cars (2; followed as moving bodies), people (3), bikes (4). */
const CAR_MEMBER = 0x0004;
const SKIP_MEMBERS = 0x0008 | 0x0010;
/** A dynamic body other than a car (a fallen lamp) moving faster than this (m/s) is not copied: it would be a stale obstacle. */
const MOVING = 0.5;

/**
 * A Rapier world of its own for ragdolls, so the tumbling bodies never touch the predicted (server-replayed) sim world.
 * It holds only what lies around a ragdoll: cover(x, z) copies the static city of the cells there out of the sim's
 * world (trimesh tiles and the terrain heightfield cropped into one mesh per cell; street furniture as its own shapes),
 * and drops cells nobody used for KEEP_S. Cars there (parked, driven, streamed) become kinematic bodies that follow
 * their source every step, so a car really strikes a ragdoll and a thrown body lands on a bonnet. Stepped at a fixed
 * 60 Hz from frame time.
 */
export class RagdollWorld {
  readonly R: PhysicsWorld['rapier'];
  readonly world: RAPIER.World;
  private readonly ground: RAPIER.RigidBody;
  private acc = 0;
  private time = 0;
  /** Ragdolls in the world (no stepping without one). */
  private users = 0;
  private readonly cells = new Map<string, { collider: RAPIER.Collider | null; used: number }>();
  /** Non-mesh colliders copied (by source collider handle), with their source to follow it if it moves. */
  private readonly shapes = new Map<number, { copy: RAPIER.Collider; used: number }>();
  /** Cars copied (by source collider handle) as kinematic bodies. */
  private readonly cars = new Map<number, { body: RAPIER.RigidBody; used: number }>();

  constructor(private readonly src: PhysicsWorld) {
    const R = (this.R = src.rapier);
    this.world = new R.World({ x: 0, y: TUNING.world.gravity, z: 0 });
    this.world.timestep = STEP;
    this.ground = this.world.createRigidBody(R.RigidBodyDesc.fixed());
  }

  /** The static surroundings within about one cell of (x, z) are in the world. */
  cover(x: number, z: number): void {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) this.cell(cx + i, cz + k);
  }

  /** Advances by frame time dt (fixed steps; nothing while no ragdoll is in the world). */
  step(dt: number): void {
    this.time += dt;
    if (this.users > 0) {
      this.acc += Math.min(dt, 0.25);
      const n = Math.min(MAX_STEPS, Math.floor(this.acc / STEP));
      this.acc = n === MAX_STEPS ? 0 : this.acc - n * STEP;
      // the cars move from where they are to their source's pose over this frame's steps
      const moves: { body: RAPIER.RigidBody; t0: Vector3; t1: Vector3; q0: Quaternion; q1: Quaternion }[] = [];
      for (const [h, car] of this.cars) {
        const c = this.src.world.getCollider(h);
        if (!c) {
          this.world.removeRigidBody(car.body);
          this.cars.delete(h);
          continue;
        }
        const a = car.body.translation(), b = c.translation(), qa = car.body.rotation(), qb = c.rotation();
        moves.push({ body: car.body, t0: new Vector3(a.x, a.y, a.z), t1: new Vector3(b.x, b.y, b.z), q0: new Quaternion(qa.x, qa.y, qa.z, qa.w), q1: new Quaternion(qb.x, qb.y, qb.z, qb.w) });
      }
      const t = new Vector3(), q = new Quaternion();
      for (let k = 1; k <= n; k++) {
        for (const m of moves) {
          m.body.setNextKinematicTranslation(t.lerpVectors(m.t0, m.t1, k / n));
          m.body.setNextKinematicRotation(q.slerpQuaternions(m.q0, m.q1, k / n));
        }
        this.world.step();
      }
    } else {
      // idle: the copied cars are dropped, so none jumps from a stale pose into the next ragdoll
      this.acc = 0;
      for (const car of this.cars.values()) this.world.removeRigidBody(car.body);
      this.cars.clear();
    }
    this.evict();
  }

  /** A part body: dynamic, at `pos` turned by `rot`, CCD on (thrown fast at thin walls). */
  addBody(pos: Vec3, rot: Quaternion, vel: Vec3): RAPIER.RigidBody {
    const R = this.R;
    return this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setLinvel(vel.x, vel.y, vel.z).setLinearDamping(0.05).setAngularDamping(1.0).setCcdEnabled(true),
    );
  }

  /** A part's collider: only collides with the surroundings, never with other parts. */
  addCollider(desc: RAPIER.ColliderDesc, body: RAPIER.RigidBody): RAPIER.Collider {
    return this.world.createCollider(desc.setCollisionGroups(PART_GROUPS).setFriction(1.0).setRestitution(0.05).setDensity(985), body);
  }

  /** Counts a ragdoll in (true) or out. */
  use(on: boolean): void {
    this.users = Math.max(0, this.users + (on ? 1 : -1));
  }

  private cell(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    const have = this.cells.get(key);
    const x0 = cx * CELL - MARGIN, x1 = (cx + 1) * CELL + MARGIN, z0 = cz * CELL - MARGIN, z1 = (cz + 1) * CELL + MARGIN;
    const centre = { x: (x0 + x1) / 2, y: 0, z: (z0 + z1) / 2 }, half = { x: (x1 - x0) / 2, y: 1e4, z: (z1 - z0) / 2 };
    const verts: number[] = [], idx: number[] = [];
    this.src.world.collidersWithAabbIntersectingAabb(centre, half, (c) => {
      // (the city keeps Rapier's default groups: member of every bit)
      const member = c.collisionGroups() >>> 16;
      if (c.isSensor() || (member !== 0xffff && member & SKIP_MEMBERS)) return true;
      if (member !== 0xffff && member & CAR_MEMBER) {
        this.copyCar(c);
        return true;
      }
      const b = c.parent();
      if (b && b.isKinematic()) return true;
      const type = c.shapeType();
      if (type === this.R.ShapeType.TriMesh || type === this.R.ShapeType.HeightField) {
        if (!have) cropMesh(c, x0, x1, z0, z1, verts, idx, this.R);
      } else this.copyShape(c);
      return true;
    });
    if (have) {
      have.used = this.time;
      return;
    }
    const collider = idx.length > 0
      ? this.world.createCollider(this.R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)).setFriction(0.9), this.ground)
      : null;
    this.cells.set(key, { collider, used: this.time });
  }

  /** A car's chassis as a kinematic body (made once at the source's pose; step() moves it along). */
  private copyCar(c: RAPIER.Collider): void {
    let car = this.cars.get(c.handle);
    if (!car) {
      const R = this.R, t = c.translation();
      const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(t.x, t.y, t.z).setRotation(c.rotation()));
      this.world.createCollider(new R.ColliderDesc(c.shape).setFriction(0.6).setCollisionGroups(CAR_COPY_GROUPS), body);
      car = { body, used: this.time };
      this.cars.set(c.handle, car);
    }
    car.used = this.time;
  }

  /** A copy of a non-mesh collider (furniture): made once, then kept where its source is. */
  private copyShape(c: RAPIER.Collider): void {
    const b = c.parent();
    const moving = b?.isDynamic() && Math.hypot(b.linvel().x, b.linvel().y, b.linvel().z) > MOVING;
    let s = this.shapes.get(c.handle);
    if (moving) {
      if (s) this.world.removeCollider(s.copy, false);
      this.shapes.delete(c.handle);
      return;
    }
    if (!s) {
      const copy = this.world.createCollider(new this.R.ColliderDesc(c.shape).setFriction(c.friction()), this.ground);
      s = { copy, used: this.time };
      this.shapes.set(c.handle, s);
    }
    s.used = this.time;
    s.copy.setTranslation(c.translation());
    s.copy.setRotation(c.rotation());
  }

  private evict(): void {
    for (const [key, c] of this.cells) {
      if (this.time - c.used < KEEP_S) continue;
      if (c.collider) this.world.removeCollider(c.collider, false);
      this.cells.delete(key);
    }
    for (const [h, s] of this.shapes) {
      if (this.time - s.used < KEEP_S) continue;
      this.world.removeCollider(s.copy, false);
      this.shapes.delete(h);
    }
    for (const [h, car] of this.cars) {
      if (this.time - car.used < KEEP_S) continue;
      this.world.removeRigidBody(car.body);
      this.cars.delete(h);
    }
  }

  dispose(): void {
    this.world.free();
  }
}

/** Appends the triangles of a trimesh or heightfield collider whose x/z bounds overlap [x0, x1] × [z0, z1] (world space). */
function cropMesh(c: RAPIER.Collider, x0: number, x1: number, z0: number, z1: number, verts: number[], idx: number[], R: PhysicsWorld['rapier']): void {
  const t = c.translation(), r = c.rotation();
  const q = new Quaternion(r.x, r.y, r.z, r.w);
  const v = new Vector3();
  const base = () => verts.length / 3;
  const push = (x: number, y: number, z: number) => {
    v.set(x, y, z).applyQuaternion(q);
    verts.push(v.x + t.x, v.y + t.y, v.z + t.z);
  };
  const overlaps = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    Math.max(ax, bx, cx) >= x0 && Math.min(ax, bx, cx) <= x1 && Math.max(az, bz, cz) >= z0 && Math.min(az, bz, cz) <= z1;
  if (c.shapeType() === R.ShapeType.TriMesh) {
    const m = c.shape as RAPIER.TriMesh;
    const V = m.vertices, I = m.indices;
    const map = new Map<number, number>();
    const at = (i: number) => {
      let k = map.get(i);
      if (k === undefined) {
        k = base();
        push(V[3 * i]!, V[3 * i + 1]!, V[3 * i + 2]!);
        map.set(i, k);
      }
      return k;
    };
    // the tile's vertices in world space for the bounds test (tiles sit unrotated at the origin; others are rare)
    const wx = (i: number) => (r.w === 1 ? V[3 * i]! + t.x : v.set(V[3 * i]!, V[3 * i + 1]!, V[3 * i + 2]!).applyQuaternion(q).x + t.x);
    const wz = (i: number) => (r.w === 1 ? V[3 * i + 2]! + t.z : v.set(V[3 * i]!, V[3 * i + 1]!, V[3 * i + 2]!).applyQuaternion(q).z + t.z);
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k]!, b = I[k + 1]!, d = I[k + 2]!;
      if (!overlaps(wx(a), wz(a), wx(b), wz(b), wx(d), wz(d))) continue;
      idx.push(at(a), at(b), at(d));
    }
    return;
  }
  // heightfield: nrows cells along local z, ncols along x, heights column-major, spanning ±scale/2 (see world.ts)
  const h = c.shape as RAPIER.Heightfield;
  const { nrows, ncols, heights, scale } = h;
  const dx = scale.x / ncols, dz = scale.z / nrows;
  const col = (x: number) => (x - t.x) / dx + ncols / 2, row = (z: number) => (z - t.z) / dz + nrows / 2;
  const c0 = Math.max(0, Math.floor(col(x0))), c1 = Math.min(ncols, Math.ceil(col(x1)));
  const r0 = Math.max(0, Math.floor(row(z0))), r1 = Math.min(nrows, Math.ceil(row(z1)));
  if (c0 >= c1 || r0 >= r1) return;
  const start = base(), w = r1 - r0 + 1;
  for (let ci = c0; ci <= c1; ci++) for (let ri = r0; ri <= r1; ri++) {
    push((ci / ncols - 0.5) * scale.x, heights[ci * (nrows + 1) + ri]! * scale.y, (ri / nrows - 0.5) * scale.z);
  }
  const at = (ci: number, ri: number) => start + (ci - c0) * w + (ri - r0);
  for (let ci = c0; ci < c1; ci++) for (let ri = r0; ri < r1; ri++) {
    // both windings face up (+y): (c, r) → (c, r+1) → (c+1, r) is counter-clockwise seen from above
    idx.push(at(ci, ri), at(ci, ri + 1), at(ci + 1, ri), at(ci + 1, ri), at(ci, ri + 1), at(ci + 1, ri + 1));
  }
}
