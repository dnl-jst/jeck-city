import type RAPIER from '@dimforge/rapier3d-compat';
import type { WorldManifest } from '../assets/manifest';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { RiddenBike, bikeColliderRadius } from './bike';
import { BIKE_SPECS, BIKE_TYPES, type BikeType } from './biketypes';
import { TUNING } from './tuning';
import { BIKE_GROUPS, CAR_GROUPS, PROP_GROUPS, staticWorldFilter, type PhysicsWorld } from './world';

/**
 * Ground under the wheels (y) and heading (forward = (sin h, cos h)). fall: lying on its left side (1, rider's left),
 * its right side (−1) or standing (0, also when missing).
 */
export type BikePose = { x: number; y: number; z: number; heading: number; fall?: number };

/** The fall of a pose: 1 (lying on its left side), −1 (right side) or 0 (standing). */
export const fallOf = (p: BikePose): -1 | 0 | 1 => (p.fall === undefined || p.fall === 0 ? 0 : p.fall > 0 ? 1 : -1);

const T = TUNING.bike;
/** Parked bike box: half height; it rests on the ground. */
const BOX_HALF_Y = 0.45;
/** Ground friction of a parked bike (low: it rolls out after getting off) and extra damping. */
const FRICTION = 0.3;
const LINEAR_DAMPING = 0.4;
/** Half width of a parked dutch/road/mtb box: the frame, not the handlebar (rack slots are 0.5 m apart). */
const SLIM_HALF_X = 0.15;
const CARGO: ReadonlySet<BikeType> = new Set(['longjohn', 'trike', 'soundjohn']);
const ANGULAR_DAMPING = 3;
/**
 * A lying bike's box: flat (half height LIE_HALF_Y) and beside the line between its wheels, on the side it lies on
 * (centre LIE_HALF_X out). It collides with the static city only (LYING_BIKE_GROUPS): no car body bulldozes it, no
 * bike, person or rack is shoved by it, the wheel rays still roll over it.
 */
const LIE_HALF_X = 0.45;
const LIE_HALF_Y = 0.15;
/** A bike on its side scrapes over the ground: it stops after a short slide. */
const LIE_FRICTION = 0.8;
const LIE_LINEAR_DAMPING = 2;
/** Bikes (bit 4) that only collide with the static city (bit 0): see LIE_HALF_X. */
export const LYING_BIKE_GROUPS = 0x0010_0001;
/** What knocks a standing bike over (membership bits): a car's chassis or a bike (ridden, or a parked one shoved into it). */
const KNOCKERS = (CAR_GROUPS >>> 16) | (BIKE_GROUPS >>> 16);
/** A standing bike a car or bike shoves along faster than SHOVE_SPEED (m/s) for parkedShoveSeconds falls over too. */
const SHOVE_SPEED = 0.3;
const SHOVE_TICKS = Math.round(T.parkedShoveSeconds / TUNING.world.dt);

const yawQuat = (h: number) => ({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });
const yawOf = (q: { x: number; y: number; z: number; w: number }) => 2 * Math.atan2(q.y, q.w);
/** A bike counts as moved once it is this far (m) or this much turned (rad) from its manifest spot. */
const MOVED_DIST = 0.05;
const MOVED_ANGLE = (2 * Math.PI) / 180;

/**
 * Unridden bikes (approach B of the bike design): dynamic boxes that can only turn about the vertical axis, so the
 * solver never tips them. Falling over is a state instead (BikePose.fall): a standing bike that a car or another bike
 * hits hard (its speed jumps by at least parkedFallDv in one step, see sync) falls to the side it was pushed to; its
 * box becomes a flat one beside it (LIE_HALF_X) and the client rolls the model over. Getting on picks it up; ridden
 * bikes never fall this way. Bodies exist only near the player (parkedPhysicsNear/Far, like parked cars); the others
 * keep their pose. mount() swaps a bike's body for a kinematic RiddenBike, dismount() back. Any number of bikes can be
 * ridden at once, each by one rider.
 */
export class ParkedBikes {
  readonly poses: BikePose[];
  readonly types: BikeType[];
  readonly colors: number[];
  /** Who rides each bike (a player id), null while it is free. */
  readonly rider: (number | null)[];
  /** Manifest pose of every bike (where the idle reset puts it back). */
  private readonly home: BikePose[];
  private readonly bodies = new Map<number, RAPIER.RigidBody>();
  /** Bikes placed kinematically on a streamed pose (client prediction, see follow). */
  private readonly followed = new Set<number>();
  /** Horizontal velocity (x, z) and yaw rate of every awake body after the last sync: a hit is a jump from there. */
  private readonly lastVel = new Map<number, [number, number, number]>();
  /** Consecutive steps a car or bike has been shoving each standing bike along. */
  private readonly shoved = new Map<number, number>();
  /** Bikes that fell over since the last takeFallen(). */
  private fallenNow: number[] = [];
  /**
   * Whether sync() knocks bikes over (the server and offline play). The client's prediction leaves that to the server:
   * the fall arrives with the streamed or resting pose.
   */
  decideFalls = true;

  constructor(private readonly pw: PhysicsWorld, bikes: WorldManifest['bikes'], private readonly terrain?: TerrainGrid) {
    // on the static surface (sidewalks lie 0.12 m above the terrain), else the terrain
    // (knocked over in the manifest: e-scooters lying on their left side)
    this.home = bikes.map((b) => ({
      x: b.x, y: surfaceBelow(pw, b.x, b.z, this.ground(b.x, b.z) + 1.5) ?? this.ground(b.x, b.z), z: b.z, heading: b.heading, fall: b.down ? 1 : 0,
    }));
    this.poses = this.home.map((p) => ({ ...p }));
    this.types = bikes.map((b) => BIKE_TYPES[b.type]!);
    this.colors = bikes.map((b) => b.color);
    this.rider = bikes.map(() => null);
  }

  /** Ids of the bikes someone rides, ascending. */
  riddenIds(): number[] {
    const out: number[] = [];
    this.rider.forEach((r, id) => { if (r !== null) out.push(id); });
    return out;
  }

  /** Ids with a physics body, ascending. */
  activeIds(): number[] {
    return [...this.bodies.keys()].sort((a, b) => a - b);
  }

  /** The physics body of a bike, if it has one now. */
  body(id: number): RAPIER.RigidBody | undefined {
    return this.bodies.get(id);
  }

  /** Creates bodies within parkedPhysicsNear of (x, z), removes those beyond parkedPhysicsFar (keeping the pose). */
  updatePhysics(x: number, z: number): void {
    this.updateProximity([{ x, z }]);
  }

  /** updatePhysics for several foci (players): the distance to the nearest one counts. */
  updateProximity(foci: readonly { x: number; z: number }[]): void {
    const dist = (p: BikePose): number => {
      let d = Infinity;
      for (const f of foci) d = Math.min(d, Math.hypot(p.x - f.x, p.z - f.z));
      return d;
    };
    for (const [id, b] of this.bodies) {
      if (!this.followed.has(id) && dist(this.poses[id]!) > T.parkedPhysicsFar) {
        this.read(id, b);
        this.removeBody(id, b);
      }
    }
    this.poses.forEach((p, id) => {
      if (this.rider[id] === null && !this.bodies.has(id) && dist(p) <= T.parkedPhysicsNear) this.create(id);
    });
  }

  /**
   * Reads the poses of all bikes with an awake body. With decideFalls, a standing one falls over when a car or bike
   * hits it hard (its speed jumps by parkedFallDv in this step) or keeps shoving it (for parkedShoveSeconds).
   */
  sync(): void {
    for (const [id, b] of this.bodies) {
      if (this.followed.has(id)) continue;
      if (b.isSleeping()) {
        this.lastVel.delete(id);
        this.shoved.delete(id);
        continue;
      }
      this.read(id, b);
      const v = b.linvel(), w = b.angvel().y;
      const last = this.lastVel.get(id) ?? [0, 0, 0];
      this.lastVel.set(id, [v.x, v.z, w]);
      if (!this.decideFalls || fallOf(this.poses[id]!) !== 0) continue;
      // the jump in speed this step, of the centre and of the bike's ends (a hit at the front wheel spins it)
      const dx = v.x - last[0], dz = v.z - last[1];
      const ends = Math.abs(w - last[2]) * (BIKE_SPECS[this.types[id]!].wheelbase / 2 + 0.3);
      const hit = Math.max(Math.hypot(dx, dz), ends) >= T.parkedFallDv;
      if ((!hit && Math.hypot(v.x, v.z) < SHOVE_SPEED) || !this.touchesKnocker(b)) {
        this.shoved.delete(id);
        continue;
      }
      const n = (this.shoved.get(id) ?? 0) + 1;
      this.shoved.set(id, n);
      if (!hit && n < SHOVE_TICKS) continue;
      // pushed to its left (cos h, −sin h) or right; straight along it (front or back): the left, where it leans
      const [px, pz] = hit ? [dx, dz] : [v.x, v.z];
      const h = this.poses[id]!.heading;
      this.setFall(id, px * Math.cos(h) - pz * Math.sin(h) >= 0 ? 1 : -1);
      this.shoved.delete(id);
      this.fallenNow.push(id);
    }
  }

  /** Ids of the bikes that fell over since the last call, ascending. */
  takeFallen(): number[] {
    const out = this.fallenNow.sort((a, b) => a - b);
    this.fallenNow = [];
    return out;
  }

  /** Whether a car or a bike touches the body of a parked bike. */
  private touchesKnocker(b: RAPIER.RigidBody): boolean {
    const w = this.pw.world, mine = b.collider(0), near: RAPIER.Collider[] = [];
    // (pairs exist for overlapping bounding boxes, and for groups that do not collide: only real contact points count.
    // Collected first: a query inside the pair callback would be a recursive use of the world.)
    w.contactPairsWith(mine, (c) => { if (((c.collisionGroups() >>> 16) & KNOCKERS) !== 0) near.push(c); });
    let hit = false;
    for (const c of near) w.contactPair(mine, c, (m) => { if (m.numContacts() > 0) hit = true; });
    return hit;
  }

  /** Bike `id` stands (0) or lies on its left (1) or right (−1) side; a body it has gets the matching box. */
  private setFall(id: number, fall: -1 | 0 | 1): void {
    const p = this.poses[id]!;
    if (fallOf(p) === fall) return;
    p.fall = fall;
    const b = this.bodies.get(id);
    if (!b) return;
    this.pw.world.removeCollider(b.collider(0), false);
    this.pw.world.createCollider(this.collider(id), b);
    b.setLinearDamping(fall !== 0 ? LIE_LINEAR_DAMPING : LINEAR_DAMPING);
  }

  /** The side unridden bike `id` lies on (1 left, −1 right; knocked over, or so in the manifest), 0 standing or ridden. */
  fallSide(id: number): -1 | 0 | 1 {
    return this.rider[id] === null ? fallOf(this.poses[id]!) : 0;
  }

  /** Ids of the bikes with an awake dynamic body (pushed, rolling), ascending. */
  awake(): number[] {
    const out: number[] = [];
    for (const [id, b] of this.bodies) if (!this.followed.has(id) && !b.isSleeping()) out.push(id);
    return out.sort((a, b) => a - b);
  }

  /** The closest unridden bike whose axis (wheelbase) is within maxDist of p, or null. */
  nearestMountable(p: { x: number; z: number }, maxDist = 2): number | null {
    return this.nearest(p, maxDist, false);
  }

  /** The closest bike someone rides within maxDist of p (as nearestMountable), or null: E there is refused. */
  nearestRidden(p: { x: number; z: number }, maxDist = 2): number | null {
    return this.nearest(p, maxDist, true);
  }

  private nearest(p: { x: number; z: number }, maxDist: number, ridden: boolean): number | null {
    let best: number | null = null, bestD = maxDist;
    this.poses.forEach((b, id) => {
      if ((this.rider[id] !== null) !== ridden) return;
      const half = BIKE_SPECS[this.types[id]!].wheelbase / 2 + 0.3;
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      const t = Math.max(-half, Math.min(half, (p.x - b.x) * fx + (p.z - b.z) * fz));
      const d = Math.hypot(p.x - (b.x + fx * t), p.z - (b.z + fz * t));
      if (d <= bestD) [best, bestD] = [id, d];
    });
    return best;
  }

  /** Player `who` gets on bike `id`: removes its body and returns a RiddenBike at its pose. */
  mount(id: number, who: number): RiddenBike {
    const b = this.bodies.get(id);
    if (b) this.read(id, b);
    // the parked box stays level, so on a slope it rests on its lowest corner: start on the surface below its centre
    // (queried before the body goes: a removed collider stays in the query pipeline until the next step)
    const p = this.poses[id]!;
    // (a vertical ray exactly on a heightfield cell edge can miss it: fall back to the terrain height)
    const y = this.surface(p.x, p.z, p.y + 0.6) ?? (this.terrain ? heightAt(this.terrain, p.x, p.z) : p.y);
    if (b) this.removeBody(id, b);
    this.followed.delete(id);
    this.rider[id] = who;
    p.fall = 0; // getting on picks a lying bike up
    return new RiddenBike(this.pw, this.types[id]!, { x: p.x, y, z: p.z, heading: p.heading });
  }

  /** Disposes the ridden bike and puts a dynamic body in its place, moving at its speed (it rolls out). */
  dismount(id: number, bike: RiddenBike): void {
    const s = bike.state();
    bike.dispose();
    this.poses[id] = { x: s.x, y: s.y, z: s.z, heading: s.heading, fall: 0 };
    this.rider[id] = null;
    const b = this.create(id);
    const v = { x: Math.sin(s.heading) * s.speed, y: 0, z: Math.cos(s.heading) * s.speed };
    b.setLinvel(v, true);
    this.lastVel.set(id, [v.x, v.z, 0]); // rolling out is no hit
  }

  /**
   * Bike `id` as a kinematic body on `pose` (client prediction: a bike someone else rides, or one the server streams
   * because it rolls). It moves there in the next step and shoves the own figure, car or bike; it is never pushed itself.
   */
  follow(id: number, pose: BikePose): void {
    this.setFall(id, fallOf(pose));
    this.poses[id] = { ...pose };
    let b = this.bodies.get(id);
    if (!b) b = this.create(id);
    const t = { x: pose.x, y: pose.y + BOX_HALF_Y + 0.005, z: pose.z }, q = yawQuat(pose.heading);
    if (!this.followed.has(id)) {
      this.followed.add(id);
      b.setBodyType(this.pw.rapier.RigidBodyType.KinematicPositionBased, true);
      b.setTranslation(t, true);
      b.setRotation(q, true);
    }
    b.setNextKinematicTranslation(t);
    b.setNextKinematicRotation(q);
  }

  /** A followed bike the server no longer streams: dynamic again, at rest on `pose` (where the server says it stands). */
  release(id: number, pose: BikePose): void {
    if (!this.followed.delete(id)) return;
    const b = this.bodies.get(id)!;
    b.setBodyType(this.pw.rapier.RigidBodyType.Dynamic, false);
    this.rest(id, pose);
  }

  /**
   * Client prediction: puts unridden, unfollowed bike `id` at rest on `pose` (where the server's slow state says it
   * stands). No-op while ridden or followed.
   */
  place(id: number, pose: BikePose): void {
    if (this.rider[id] === null && !this.followed.has(id)) this.rest(id, pose);
  }

  /** Bike `id` on `pose`, its body (if any) there at rest and asleep. */
  private rest(id: number, pose: BikePose): void {
    this.setFall(id, fallOf(pose));
    this.poses[id] = { ...pose };
    this.lastVel.delete(id);
    this.shoved.delete(id);
    const b = this.bodies.get(id);
    if (!b) return;
    b.setTranslation({ x: pose.x, y: pose.y + BOX_HALF_Y + 0.005, z: pose.z }, false);
    b.setRotation(yawQuat(pose.heading), false);
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.sleep();
  }

  /** The manifest pose of bike `id`. */
  homePose(id: number): BikePose {
    return { ...this.home[id]! };
  }

  /** Bikes currently followed (see follow). */
  following(): ReadonlySet<number> {
    return this.followed;
  }

  /** Whether bike `id` stands more than 5 cm or 2° away from its manifest spot, or fell over (or got up) since. */
  isMoved(id: number): boolean {
    const p = this.poses[id]!, h = this.home[id]!;
    if (fallOf(p) !== fallOf(h)) return true;
    if (Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z) > MOVED_DIST) return true;
    const d = p.heading - h.heading;
    return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > MOVED_ANGLE;
  }

  /** Puts unridden bike `id` back on its manifest spot (a resting body there if it had one). No-op while ridden or followed. */
  reset(id: number): void {
    if (this.rider[id] !== null || this.followed.has(id)) return;
    this.poses[id] = { ...this.home[id]! };
    const b = this.bodies.get(id);
    if (!b) return;
    this.removeBody(id, b);
    this.create(id);
  }

  /** A standing person (capsule from the ground at y) at (x, z) touches nothing solid. */
  standFree(x: number, z: number, y: number): boolean {
    const { rapier: R, world: w } = this.pw;
    const C = TUNING.character;
    const capsule = new R.Capsule(C.height / 2 - C.radius, C.radius);
    const centre = { x, y: y + 0.3 + C.height / 2, z }; // 0.3 m up: clears kerbs
    return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, staticWorldFilter(true, undefined, true)) === null;
  }

  /**
   * The rider can step off the bike at `bike` to (x, z): the way there is clear at hip height (no wall, car or post in
   * between – a spot inside a closed building touches nothing, so standFree alone would accept it) and a standing
   * capsule fits at the spot.
   */
  canStepOff(bike: { x: number; y: number; z: number }, x: number, z: number): boolean {
    const { rapier: R, world: w } = this.pw;
    const dx = x - bike.x, dz = z - bike.z, d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      const solid = staticWorldFilter(true, undefined, true);
      const hit = w.castRay(new R.Ray({ x: bike.x, y: bike.y + 0.9, z: bike.z }, { x: dx / d, y: 0, z: dz / d }), d + TUNING.character.radius, true,
        undefined, undefined, undefined, undefined, (c) => solid(c) && !this.isParkedBike(c));
      if (hit) return false;
    }
    return this.standFree(x, z, bike.y);
  }

  private isParkedBike(c: RAPIER.Collider): boolean {
    const b = c.parent();
    if (!b) return false;
    for (const body of this.bodies.values()) if (body.handle === b.handle) return true;
    return false;
  }

  private surface(x: number, z: number, fromY: number): number | null {
    return surfaceBelow(this.pw, x, z, fromY);
  }

  private ground(x: number, z: number): number {
    return this.terrain ? heightAt(this.terrain, x, z) : 0;
  }

  private removeBody(id: number, b: RAPIER.RigidBody): void {
    this.pw.world.removeRigidBody(b);
    this.bodies.delete(id);
    this.lastVel.delete(id);
    this.shoved.delete(id);
  }

  /** The box of bike `id` (relative to its body), standing or lying as its pose. */
  private collider(id: number): RAPIER.ColliderDesc {
    const R = this.pw.rapier, spec = BIKE_SPECS[this.types[id]!], fall = fallOf(this.poses[id]!);
    const hz = spec.wheelbase / 2 + 0.3;
    if (fall !== 0) {
      // on the ground beside the wheels, on the side it lies on (local +x is the bike's left)
      return R.ColliderDesc.cuboid(LIE_HALF_X, LIE_HALF_Y, hz).setTranslation(fall * LIE_HALF_X, LIE_HALF_Y - BOX_HALF_Y, 0)
        .setMass(spec.massParked).setFriction(LIE_FRICTION).setCollisionGroups(LYING_BIKE_GROUPS);
    }
    return R.ColliderDesc.cuboid(CARGO.has(this.types[id]!) ? bikeColliderRadius(spec) : SLIM_HALF_X, BOX_HALF_Y, hz)
      .setMass(spec.massParked)
      .setFriction(FRICTION)
      .setCollisionGroups(BIKE_GROUPS);
  }

  private create(id: number): RAPIER.RigidBody {
    const { rapier: R, world } = this.pw;
    const p = this.poses[id]!;
    const b = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + BOX_HALF_Y + 0.005, p.z)
        .setRotation(yawQuat(p.heading))
        .enabledRotations(false, true, false)
        .setLinearDamping(fallOf(p) !== 0 ? LIE_LINEAR_DAMPING : LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCanSleep(true),
    );
    world.createCollider(this.collider(id), b);
    this.bodies.set(id, b);
    return b;
  }

  private read(id: number, b: RAPIER.RigidBody): void {
    const t = b.translation();
    this.poses[id] = { x: t.x, y: t.y - BOX_HALF_Y, z: t.z, heading: yawOf(b.rotation()), fall: fallOf(this.poses[id]!) };
  }
}

/** Hoop collider half extents: kind 0 stand (inverted U, long side along the bikes), 1 wall loop / bollard. */
const RACK_HALF: Record<0 | 1, [number, number, number]> = { 0: [0.03, 0.4, 0.45], 1: [0.15, 0.45, 0.15] };

/** First static surface (city, terrain) below (x, fromY, z) within 3 m, or null. */
export function surfaceBelow(pw: PhysicsWorld, x: number, z: number, fromY: number): number | null {
  const { rapier: R, world: w } = pw;
  const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 3, true, undefined, undefined, undefined, undefined, staticWorldFilter());
  return hit ? fromY - hit.timeOfImpact : null;
}

/** Bike rack hoops as fixed street furniture (one collider per hoop). ys: the ground height of each hoop. */
export class BikeRacks {
  readonly ys: number[] = [];

  constructor(pw: PhysicsWorld, racks: WorldManifest['bikeRacks'], terrain?: TerrainGrid) {
    const { rapier: R, world } = pw;
    // surfaces first: the hoop colliders must not be hit by the rays of their neighbours
    for (const r of racks) {
      const g = terrain ? heightAt(terrain, r.x, r.z) : 0;
      this.ys.push(surfaceBelow(pw, r.x, r.z, g + 1.5) ?? g);
    }
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const [i, r] of racks.entries()) {
      const [hx, hy, hz] = RACK_HALF[r.kind];
      const y = this.ys[i]!;
      world.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(r.x, y + hy, r.z).setRotation(yawQuat(r.heading)).setCollisionGroups(PROP_GROUPS),
        body,
      );
    }
  }
}

/** Where the rider steps off: 1 m to the left, 1 m to the right, 1.6 m behind (first free one), or null. */
export function dismountSpot(bike: BikePose, isFree: (x: number, z: number) => boolean): { x: number; z: number } | null {
  const fx = Math.sin(bike.heading), fz = Math.cos(bike.heading);
  // right of the heading is (−cos h, sin h), so left is (cos h, −sin h)
  const lx = fz, lz = -fx;
  const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0; // + 0: no −0 in results
  for (const [ox, oz] of [[lx, lz], [-lx, -lz], [-fx * 1.6, -fz * 1.6]] as const) {
    const x = round(bike.x + ox), z = round(bike.z + oz);
    if (isFree(x, z)) return { x, z };
  }
  return null;
}
