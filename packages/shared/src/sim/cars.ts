import type { WorldManifest } from '../assets/manifest';
import type { TerrainGrid } from '../assets/terrain';
import { carTypeOf, type CarType } from '../physics/cartypes';
import { CAR_SEATS } from '../physics/carseats';
import { Vehicle, VEHICLE_REST_Y } from '../physics/vehicle';
import type { PhysicsWorld } from '../physics/world';
import type { StationId } from '../net/constants';
import { headingOf, parkedPose, type CarPose } from './rules';

/** A parked car gets a physics body within this distance (m) of any focus. */
export const CAR_PHYSICS_NEAR = 150;
/** ... and loses it again (keeping its pose) beyond this distance from every focus. */
export const CAR_PHYSICS_FAR = 200;

/** A car counts as moved once it is this far (m) or this much rotated (rad) from its manifest spot. */
const MOVED_DIST = 0.05;
const MOVED_ANGLE = (2 * Math.PI) / 180;

/** Slot number of a player (0..MAX_PLAYERS − 1). */
export type PlayerId = number;

/**
 * All manifest cars without rendering: their last known pose, colour, driver and car radio. Only cars near a focus
 * (a player) have a physics Vehicle; the others are just a stored pose (the manifest spot or where they were left).
 */
export class CarPool {
  readonly poses: CarPose[];
  readonly colors: number[];
  /** Model (and chassis size) of each car. */
  readonly types: CarType[];
  readonly driver: (PlayerId | null)[];
  /** Who sits on each seat of each car besides the driver (index = seat; seat 0 is `driver`'s and stays null here). */
  readonly riders: (PlayerId | null)[][];
  /** Radio station playing in each car; null while off or without a driver. */
  readonly radio: (StationId | null)[];
  /** Manifest pose of every car. */
  private readonly home: CarPose[];
  private readonly vehicles = new Map<number, Vehicle>();
  /** Cars placed kinematically on a streamed pose (client prediction, see follow). */
  private readonly followed = new Set<number>();

  constructor(private readonly pw: PhysicsWorld, parked: WorldManifest['parked'], terrain: TerrainGrid) {
    this.home = parked.map((c) => parkedPose(c.x, c.z, c.heading, terrain));
    this.poses = this.home.map((p) => ({ ...p }));
    this.colors = parked.map((c) => c.color);
    this.types = parked.map((c) => carTypeOf(c.type));
    this.driver = parked.map(() => null);
    this.riders = this.types.map((t) => CAR_SEATS[t].seats.map(() => null));
    this.radio = parked.map(() => null);
  }

  get count(): number {
    return this.poses.length;
  }

  /** Whether anybody sits in car i (driving or riding along). */
  occupied(i: number): boolean {
    return this.driver[i] !== null || this.riders[i]!.some((r) => r !== null);
  }

  /** Which seats of car i are taken (index = seat). */
  taken(i: number): boolean[] {
    return this.riders[i]!.map((r, s) => (s === 0 ? this.driver[i] !== null : r !== null));
  }

  /** Player `id` sits down on passenger seat `seat` (≥ 1) of car i: the car is left as it is. */
  sit(i: number, seat: number, id: PlayerId): void {
    this.riders[i]![seat] = id;
  }

  /** The passenger on `seat` of car i gets out. */
  stand(i: number, seat: number): void {
    this.riders[i]![seat] = null;
  }

  /** The physics car of car i, or null while it has none. */
  vehicle(i: number): Vehicle | null {
    return this.vehicles.get(i) ?? null;
  }

  /** Creates physics cars within CAR_PHYSICS_NEAR of any focus and disposes driverless ones beyond CAR_PHYSICS_FAR of all foci (keeping their pose). */
  updateProximity(foci: readonly { x: number; z: number }[]): void {
    for (let i = 0; i < this.poses.length; i++) {
      const s = this.poses[i]!;
      let d = Infinity;
      for (const f of foci) d = Math.min(d, Math.hypot(s.x - f.x, s.z - f.z));
      const v = this.vehicles.get(i);
      if (!v && d <= CAR_PHYSICS_NEAR) this.vehicles.set(i, this.spawn(i));
      else if (v && d > CAR_PHYSICS_FAR && !this.occupied(i) && !this.followed.has(i)) {
        this.poses[i] = v.pose();
        v.dispose();
        this.vehicles.delete(i);
      }
    }
  }

  /** A sleeping Vehicle at the car's stored pose (its original spot or where it was pushed to). */
  private spawn(i: number): Vehicle {
    const s = this.poses[i]!;
    const v = new Vehicle(this.pw, { x: s.x, z: s.z, heading: headingOf(s), y: s.y - VEHICLE_REST_Y }, this.types[i]);
    // tilted on a slope (or left tilted after a push): keep the stored rotation
    if (Math.abs(s.qx) + Math.abs(s.qz) > 1e-4) v.chassis.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, false);
    return v;
  }

  /** Copies the poses of awake (pushed, driven or followed) physics cars into poses. */
  sync(): void {
    for (const [i, v] of this.vehicles) if (!v.chassis.isSleeping() || this.followed.has(i)) this.poses[i] = v.pose();
  }

  /**
   * Car i as a kinematic body on `pose` (client prediction: a car someone else drives or the server streams). It moves
   * there in the next step, pushes the own car out of its way and is never pushed itself. Created if it has no body.
   */
  follow(i: number, pose: CarPose): void {
    let v = this.vehicles.get(i);
    if (!v) {
      this.poses[i] = { ...pose };
      this.vehicles.set(i, (v = this.spawn(i)));
    }
    const b = v.chassis;
    const t = { x: pose.x, y: pose.y, z: pose.z }, q = { x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw };
    if (!this.followed.has(i)) {
      this.followed.add(i);
      b.setBodyType(this.pw.rapier.RigidBodyType.KinematicPositionBased, true);
      b.setTranslation(t, true);
      b.setRotation(q, true);
    }
    b.setNextKinematicTranslation(t);
    b.setNextKinematicRotation(q);
  }

  /** A followed car the server no longer streams: dynamic again, at rest on `pose` (where the server says it stands). */
  release(i: number, pose: CarPose): void {
    if (!this.followed.delete(i)) return;
    const b = this.vehicles.get(i)!.chassis;
    b.setBodyType(this.pw.rapier.RigidBodyType.Dynamic, false);
    b.setTranslation({ x: pose.x, y: pose.y, z: pose.z }, false);
    b.setRotation({ x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw }, false);
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.sleep();
    this.poses[i] = { ...pose };
  }

  /**
   * Driverless car i at rest on `pose` (client: where the server's slow state has it): a followed car is released
   * there; a physics car is set there with no velocity, asleep. No-op while someone drives it.
   */
  place(i: number, pose: CarPose): void {
    if (this.driver[i] !== null) return;
    if (this.followed.has(i)) return this.release(i, pose);
    const v = this.vehicles.get(i);
    if (v) {
      const b = v.chassis;
      b.setTranslation({ x: pose.x, y: pose.y, z: pose.z }, false);
      b.setRotation({ x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw }, false);
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.sleep();
    }
    this.poses[i] = { ...pose };
  }

  /** The manifest pose of car i. */
  homePose(i: number): CarPose {
    return { ...this.home[i]! };
  }

  /** Cars currently followed (see follow). */
  following(): ReadonlySet<number> {
    return this.followed;
  }

  /** Cars for nearestEnterableCar. */
  candidates(): { id: number; x: number; z: number; full: boolean }[] {
    // (full: no seat left)
    return this.poses.map((s, id) => ({ id, x: s.x, z: s.z, full: this.taken(id).every((t) => t) }));
  }

  /** Player `id` takes car i: returns its (occupied, awake) Vehicle. */
  enter(i: number, id: PlayerId): Vehicle {
    let v = this.vehicles.get(i);
    if (!v) this.vehicles.set(i, (v = this.spawn(i)));
    if (this.followed.has(i)) {
      // a streamed stand-in becomes the own (dynamic) car where it stands
      this.followed.delete(i);
      v.chassis.setBodyType(this.pw.rapier.RigidBodyType.Dynamic, true);
    }
    this.driver[i] = id;
    v.setOccupied(true);
    return v;
  }

  /** The driver leaves car i where it is: parking brake on, radio off. */
  exit(i: number): void {
    if (this.driver[i] === null) return;
    const v = this.vehicles.get(i)!;
    v.setOccupied(false);
    this.poses[i] = v.pose();
    this.driver[i] = null;
    this.radio[i] = null;
  }

  /** Whether car i stands more than 5 cm or 2° away from its manifest spot. */
  isMoved(i: number): boolean {
    const v = this.vehicles.get(i);
    const p = v ? v.pose() : this.poses[i]!;
    const h = this.home[i]!;
    if (Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z) > MOVED_DIST) return true;
    const dot = Math.min(1, Math.abs(p.qx * h.qx + p.qy * h.qy + p.qz * h.qz + p.qw * h.qw));
    return 2 * Math.acos(dot) > MOVED_ANGLE;
  }

  /** Puts driverless car i back on its manifest spot (asleep, as when it was first created). No-op while driven or followed. */
  reset(i: number): void {
    if (this.occupied(i) || this.followed.has(i)) return;
    this.poses[i] = { ...this.home[i]! };
    const v = this.vehicles.get(i);
    if (!v) return;
    v.dispose();
    this.vehicles.set(i, this.spawn(i));
  }

  /** Indices of the physics cars whose chassis is awake. */
  awake(): number[] {
    const out: number[] = [];
    for (const [i, v] of this.vehicles) if (!v.chassis.isSleeping()) out.push(i);
    return out.sort((a, b) => a - b);
  }

  /** Number of physics cars (debug/tests). */
  physicsCount(): number {
    return this.vehicles.size;
  }
}
