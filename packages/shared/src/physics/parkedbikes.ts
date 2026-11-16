import type RAPIER from '@dimforge/rapier3d-compat';
import type { WorldManifest } from '../assets/manifest';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { RiddenBike, bikeColliderRadius } from './bike';
import { BIKE_SPECS, BIKE_TYPES, type BikeType } from './biketypes';
import { TUNING } from './tuning';
import { BIKE_GROUPS, PROP_GROUPS, staticWorldFilter, type PhysicsWorld } from './world';

/** Ground under the wheels (y) and heading (forward = (sin h, cos h)). */
export type BikePose = { x: number; y: number; z: number; heading: number };

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

const yawQuat = (h: number) => ({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });
const yawOf = (q: { x: number; y: number; z: number; w: number }) => 2 * Math.atan2(q.y, q.w);
/** A bike counts as moved once it is this far (m) or this much turned (rad) from its manifest spot. */
const MOVED_DIST = 0.05;
const MOVED_ANGLE = (2 * Math.PI) / 180;

/**
 * Unridden bikes (approach B of the bike design): dynamic boxes that can only turn about the vertical axis, so a car
 * shoves them but never knocks them over. Bodies exist only near the player (parkedPhysicsNear/Far, like parked cars);
 * the others keep their pose. mount() swaps a bike's body for a kinematic RiddenBike, dismount() back. Any number of
 * bikes can be ridden at once, each by one rider.
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

  constructor(private readonly pw: PhysicsWorld, bikes: WorldManifest['bikes'], private readonly terrain?: TerrainGrid) {
    // on the static surface (sidewalks lie 0.12 m above the terrain), else the terrain
    this.home = bikes.map((b) => ({ x: b.x, y: surfaceBelow(pw, b.x, b.z, this.ground(b.x, b.z) + 1.5) ?? this.ground(b.x, b.z), z: b.z, heading: b.heading }));
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
        this.pw.world.removeRigidBody(b);
        this.bodies.delete(id);
      }
    }
    this.poses.forEach((p, id) => {
      if (this.rider[id] === null && !this.bodies.has(id) && dist(p) <= T.parkedPhysicsNear) this.create(id);
    });
  }

  /** Reads the poses of all bikes with an awake body. */
  sync(): void {
    for (const [id, b] of this.bodies) if (!b.isSleeping() && !this.followed.has(id)) this.read(id, b);
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
    if (b) {
      this.pw.world.removeRigidBody(b);
      this.bodies.delete(id);
    }
    this.followed.delete(id);
    this.rider[id] = who;
    return new RiddenBike(this.pw, this.types[id]!, { ...p, y });
  }

  /** Disposes the ridden bike and puts a dynamic body in its place, moving at its speed (it rolls out). */
  dismount(id: number, bike: RiddenBike): void {
    const s = bike.state();
    bike.dispose();
    this.poses[id] = { x: s.x, y: s.y, z: s.z, heading: s.heading };
    this.rider[id] = null;
    const b = this.create(id);
    b.setLinvel({ x: Math.sin(s.heading) * s.speed, y: 0, z: Math.cos(s.heading) * s.speed }, true);
  }

  /**
   * Bike `id` as a kinematic body on `pose` (client prediction: a bike someone else rides, or one the server streams
   * because it rolls). It moves there in the next step and shoves the own figure, car or bike; it is never pushed itself.
   */
  follow(id: number, pose: BikePose): void {
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
    this.poses[id] = { ...pose };
    const b = this.bodies.get(id)!;
    b.setBodyType(this.pw.rapier.RigidBodyType.Dynamic, false);
    b.setTranslation({ x: pose.x, y: pose.y + BOX_HALF_Y + 0.005, z: pose.z }, false);
    b.setRotation(yawQuat(pose.heading), false);
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.sleep();
  }

  /**
   * Client prediction: puts unridden, unfollowed bike `id` at rest on `pose` (where the server's slow state says it
   * stands). No-op while ridden or followed.
   */
  place(id: number, pose: BikePose): void {
    if (this.rider[id] !== null || this.followed.has(id)) return;
    this.poses[id] = { ...pose };
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

  /** Whether bike `id` stands more than 5 cm or 2° away from its manifest spot. */
  isMoved(id: number): boolean {
    const p = this.poses[id]!, h = this.home[id]!;
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
    this.pw.world.removeRigidBody(b);
    this.bodies.delete(id);
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

  private create(id: number): RAPIER.RigidBody {
    const { rapier: R, world } = this.pw;
    const p = this.poses[id]!, spec = BIKE_SPECS[this.types[id]!];
    const b = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + BOX_HALF_Y + 0.005, p.z)
        .setRotation(yawQuat(p.heading))
        .enabledRotations(false, true, false)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCanSleep(true),
    );
    world.createCollider(
      R.ColliderDesc.cuboid(CARGO.has(this.types[id]!) ? bikeColliderRadius(spec) : SLIM_HALF_X, BOX_HALF_Y, spec.wheelbase / 2 + 0.3)
        .setMass(spec.massParked)
        .setFriction(FRICTION)
        .setCollisionGroups(BIKE_GROUPS),
      b,
    );
    this.bodies.set(id, b);
    return b;
  }

  private read(id: number, b: RAPIER.RigidBody): void {
    const t = b.translation();
    this.poses[id] = { x: t.x, y: t.y - BOX_HALF_Y, z: t.z, heading: yawOf(b.rotation()) };
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
