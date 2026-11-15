import type RAPIER from '@dimforge/rapier3d-compat';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { TUNING } from './tuning';
import { LYING_PROP_GROUPS, onBeforeStep, PROP_GROUPS, type PhysicsWorld } from './world';

const T = TUNING.props;
const KMH = 1 / 3.6;
/** A knocked lamp slower than this (m/s, rad/s) for this many ticks is put to sleep. */
const LAMP_CALM_LINVEL = 0.15;
const LAMP_CALM_ANGVEL = 0.3;
const LAMP_CALM_TICKS = 30;

/** Deterministic [0,1) value of a world position and a channel number (prop variation, same on every machine). */
export function propHash(x: number, z: number, k: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Overall scale of the tree at (x, z); the renderer uses the same value. */
export function treeScale(x: number, z: number): number {
  return 0.75 + 0.55 * propHash(x, z, 1);
}

type Vec3 = { x: number; y: number; z: number };

export type PropPose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };

/**
 * Trees and street lamps as physics bodies. Trees are fixed trunks. Lamps are fixed posts until a car (a dynamic
 * body of at least breakerMinMass) is about to touch one faster than lampBreakKmh: then the lamp turns dynamic,
 * gets a forward kick and spin so it topples away from the car, and the car loses the momentum it handed over.
 * Slower cars stop at the post. A knocked-down lamp no longer collides with car bodies (a bumper pushing the foot
 * would hold the post upright and shove it down the road); the wheel rays roll over it. Lamp bodies have their origin
 * at the foot of the post. With `terrain`, trunks and posts stand on the terrain (heightAt), like the rendered props;
 * without it at y = 0.
 */
export class StreetProps {
  private readonly lamps: RAPIER.RigidBody[] = [];
  /** Manifest spot of every lamp (the foot of the post, on the ground). */
  private readonly home: Vec3[] = [];
  /** Collider handle → lamp index, for standing lamps only. */
  private readonly standing = new Map<number, number>();
  private readonly fallen: number[] = [];
  /** Consecutive calm ticks of every knocked lamp (see settle). */
  private readonly calm: number[] = [];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly pw: PhysicsWorld, lamps: readonly (readonly [number, number])[], trees: readonly (readonly [number, number])[],
    terrain?: TerrainGrid,
  ) {
    const { rapier: R, world } = pw;
    const groundY = (x: number, z: number) => (terrain ? heightAt(terrain, x, z) : 0);
    for (const [x, z] of trees) {
      const k = treeScale(x, z);
      const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, groundY(x, z), z));
      world.createCollider(
        R.ColliderDesc.cylinder((T.trunkHeight * k) / 2, T.trunkRadius * k).setTranslation(0, (T.trunkHeight * k) / 2, 0).setCollisionGroups(PROP_GROUPS),
        body,
      );
    }
    lamps.forEach(([x, z], i) => {
      const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, groundY(x, z), z).setCcdEnabled(true));
      const c = world.createCollider(
        R.ColliderDesc.cylinder(T.lampHeight / 2, T.lampRadius).setTranslation(0, T.lampHeight / 2, 0).setMass(T.lampMass).setCollisionGroups(PROP_GROUPS),
        body,
      );
      this.lamps.push(body);
      this.calm.push(0);
      this.home.push({ x, y: groundY(x, z), z });
      this.standing.set(c.handle, i);
    });
    this.unsubscribe = onBeforeStep(pw, () => { this.checkHits(); this.settle(); });
  }

  /** Number of lamps. */
  get count(): number {
    return this.lamps.length;
  }

  /** Indices of lamps knocked over since the last call. */
  takeFallen(): number[] {
    return this.fallen.splice(0);
  }

  /** Whether lamp i is still standing. */
  isStanding(i: number): boolean {
    return this.standing.has(this.lamps[i]!.collider(0).handle);
  }

  /** Whether lamp i lies on the ground simulated (dynamic) and asleep: nothing more to stream. */
  isResting(i: number): boolean {
    const b = this.lamps[i]!;
    return b.isDynamic() && b.isSleeping();
  }

  /** Puts lamp i back on its manifest spot: fixed, upright, solid for cars again. */
  standUp(i: number): void {
    const b = this.lamps[i]!;
    const R = this.pw.rapier;
    const c = b.collider(0);
    b.setBodyType(R.RigidBodyType.Fixed, true);
    const h = this.home[i]!;
    b.setTranslation(h, true);
    b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, false);
    b.setAngvel({ x: 0, y: 0, z: 0 }, false);
    b.setLinearDamping(0);
    b.setAngularDamping(0);
    c.setCollisionGroups(PROP_GROUPS);
    this.standing.set(c.handle, i);
  }

  /** Lamp i as a kinematic body on `pose` (a lamp the server streams); lying groups, never breaks by itself. */
  follow(i: number, pose: PropPose): void {
    const b = this.lamps[i]!;
    const R = this.pw.rapier;
    const c = b.collider(0);
    const t = { x: pose.x, y: pose.y, z: pose.z }, q = { x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw };
    if (b.bodyType() === R.RigidBodyType.KinematicPositionBased) {
      b.setNextKinematicTranslation(t);
      b.setNextKinematicRotation(q);
      return;
    }
    this.standing.delete(c.handle);
    c.setCollisionGroups(LYING_PROP_GROUPS);
    b.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
    b.setTranslation(t, true);
    b.setRotation(q, true);
    b.setNextKinematicTranslation(t);
    b.setNextKinematicRotation(q);
  }

  /** Pose of lamp i (origin at the foot of the post). */
  lampPose(i: number): PropPose {
    const b = this.lamps[i]!;
    const p = b.translation(), q = b.rotation();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Before every step: fast cars about to touch a standing lamp (within the distance they cover this step) break it. */
  private checkHits(): void {
    if (this.standing.size === 0) return;
    const { rapier: R, world } = this.pw;
    const V = TUNING.vehicle;
    const min = T.lampBreakKmh * KMH;
    const hits: [number, RAPIER.RigidBody][] = [];
    world.forEachActiveRigidBody((car) => {
      if (!car.isDynamic() || car.mass() < T.breakerMinMass) return;
      const v = car.linvel();
      const speed = Math.hypot(v.x, v.z);
      if (speed < min) return;
      const m = speed * TUNING.world.dt + 0.05;
      const box = new R.Cuboid(V.width / 2 + m, V.height / 2 + m, V.length / 2 + m);
      world.intersectionsWithShape(car.translation(), car.rotation(), box, (c) => {
        hits.push([this.standing.get(c.handle)!, car]);
        return true;
      }, undefined, undefined, undefined, car, (c) => this.standing.has(c.handle));
    });
    for (const [i, car] of hits) this.knockOver(i, car);
  }

  /**
   * Puts knocked lamps to sleep once they have been nearly still for LAMP_CALM_TICKS: a long post on a triangle mesh
   * keeps jittering just above Rapier's own sleep threshold forever, and a lamp that never sleeps is never "resting".
   */
  private settle(): void {
    this.lamps.forEach((b, i) => {
      if (!b.isDynamic() || b.isSleeping()) { this.calm[i] = 0; return; }
      const l = b.linvel(), a = b.angvel();
      this.calm[i] = Math.hypot(l.x, l.y, l.z) < LAMP_CALM_LINVEL && Math.hypot(a.x, a.y, a.z) < LAMP_CALM_ANGVEL ? this.calm[i]! + 1 : 0;
      if (this.calm[i]! >= LAMP_CALM_TICKS) b.sleep();
    });
  }

  private knockOver(i: number, car: RAPIER.RigidBody): void {
    const lamp = this.lamps[i]!;
    if (lamp.isDynamic()) return; // two cars at once
    const collider = lamp.collider(0);
    this.standing.delete(collider.handle);
    collider.setCollisionGroups(LYING_PROP_GROUPS);
    lamp.setBodyType(this.pw.rapier.RigidBodyType.Dynamic, true);
    const v = car.linvel();
    const speed = Math.hypot(v.x, v.z);
    const dx = v.x / speed, dz = v.z / speed;
    // the car hands over the lamp's momentum (inelastic: both end up at the car's new speed)
    const keep = car.mass() / (car.mass() + T.lampMass);
    car.setLinvel({ x: v.x * keep, y: v.y, z: v.z * keep }, true);
    // centre of mass (half way up) at kick·v; ω = (dz, 0, −dx)·w turns the top (+y) towards (dx, 0, dz), so the post
    // falls away from the car while its foot (centre − w·h/2) stays just ahead of the bumper
    lamp.setLinvel({ x: v.x * T.lampKick, y: 0.5, z: v.z * T.lampKick }, true);
    const w = speed * T.lampSpin;
    lamp.setAngvel({ x: dz * w, y: 0, z: -dx * w }, true);
    // a post on flat ground has no friction about its axis: without damping it rolls (and is streamed) for minutes
    lamp.setLinearDamping(T.lampLinearDamping);
    lamp.setAngularDamping(T.lampAngularDamping);
    this.fallen.push(i);
  }
}
