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
const ANGULAR_DAMPING = 3;

const yawQuat = (h: number) => ({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) });
const yawOf = (q: { x: number; y: number; z: number; w: number }) => 2 * Math.atan2(q.y, q.w);

/**
 * Unridden bikes (approach B of the bike design): dynamic boxes that can only turn about the vertical axis, so a car
 * shoves them but never knocks them over. Bodies exist only near the player (parkedPhysicsNear/Far, like parked cars);
 * the others keep their pose. mount() swaps a bike's body for a kinematic RiddenBike, dismount() back.
 */
export class ParkedBikes {
  readonly poses: BikePose[];
  readonly types: BikeType[];
  readonly colors: number[];
  private readonly bodies = new Map<number, RAPIER.RigidBody>();
  private riddenId: number | null = null;

  constructor(private readonly pw: PhysicsWorld, bikes: WorldManifest['bikes'], private readonly terrain?: TerrainGrid) {
    this.poses = bikes.map((b) => ({ x: b.x, y: this.ground(b.x, b.z), z: b.z, heading: b.heading }));
    this.types = bikes.map((b) => BIKE_TYPES[b.type]!);
    this.colors = bikes.map((b) => b.color);
  }

  get ridden(): number | null {
    return this.riddenId;
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
    for (const [id, b] of this.bodies) {
      const p = this.poses[id]!;
      if (Math.hypot(p.x - x, p.z - z) > T.parkedPhysicsFar) {
        this.read(id, b);
        this.pw.world.removeRigidBody(b);
        this.bodies.delete(id);
      }
    }
    this.poses.forEach((p, id) => {
      if (id !== this.riddenId && !this.bodies.has(id) && Math.hypot(p.x - x, p.z - z) <= T.parkedPhysicsNear) this.create(id);
    });
  }

  /** Reads the poses of all bikes with an awake body. */
  sync(): void {
    for (const [id, b] of this.bodies) if (!b.isSleeping()) this.read(id, b);
  }

  /** The closest unridden bike whose axis (wheelbase) is within maxDist of p, or null. */
  nearestMountable(p: { x: number; z: number }, maxDist = 2): number | null {
    let best: number | null = null, bestD = maxDist;
    this.poses.forEach((b, id) => {
      if (id === this.riddenId) return;
      const half = BIKE_SPECS[this.types[id]!].wheelbase / 2 + 0.3;
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      const t = Math.max(-half, Math.min(half, (p.x - b.x) * fx + (p.z - b.z) * fz));
      const d = Math.hypot(p.x - (b.x + fx * t), p.z - (b.z + fz * t));
      if (d <= bestD) [best, bestD] = [id, d];
    });
    return best;
  }

  /** Removes the bike's body and returns a RiddenBike at its pose. */
  mount(id: number): RiddenBike {
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
    this.riddenId = id;
    return new RiddenBike(this.pw, this.types[id]!, { ...p, y });
  }

  /** Disposes the ridden bike and puts a dynamic body in its place, moving at its speed (it rolls out). */
  dismount(id: number, bike: RiddenBike): void {
    const s = bike.state();
    bike.dispose();
    this.poses[id] = { x: s.x, y: s.y, z: s.z, heading: s.heading };
    this.riddenId = null;
    const b = this.create(id);
    b.setLinvel({ x: Math.sin(s.heading) * s.speed, y: 0, z: Math.cos(s.heading) * s.speed }, true);
  }

  /** A standing person (capsule from the ground at y) at (x, z) touches nothing solid. */
  standFree(x: number, z: number, y: number): boolean {
    const { rapier: R, world: w } = this.pw;
    const C = TUNING.character;
    const capsule = new R.Capsule(C.height / 2 - C.radius, C.radius);
    const centre = { x, y: y + 0.3 + C.height / 2, z }; // 0.3 m up: clears kerbs
    return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, staticWorldFilter(true, undefined, true)) === null;
  }

  /** First static surface below (x, fromY, z) within 2 m. */
  private surface(x: number, z: number, fromY: number): number | null {
    const { rapier: R, world: w } = this.pw;
    const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), 2, true, undefined, undefined, undefined, undefined, staticWorldFilter());
    return hit ? fromY - hit.timeOfImpact : null;
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
      R.ColliderDesc.cuboid(bikeColliderRadius(spec), BOX_HALF_Y, spec.wheelbase / 2 + 0.3)
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

/** Bike rack hoops as fixed street furniture (one collider per hoop). */
export class BikeRacks {
  constructor(pw: PhysicsWorld, racks: WorldManifest['bikeRacks'], terrain?: TerrainGrid) {
    const { rapier: R, world } = pw;
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const r of racks) {
      const [hx, hy, hz] = RACK_HALF[r.kind];
      const y = terrain ? heightAt(terrain, r.x, r.z) : 0;
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
