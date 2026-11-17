import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from './tuning';
import { BIKE_GROUPS, CAR_GROUPS, CHARACTER_GROUPS, onAfterStep, type PhysicsWorld } from './world';

/** forward/right in −1..1 relative to yaw; yaw h faces (sin h, cos h) in x/z; jump takes off if standing on ground. */
export type CharacterInput = { forward: number; right: number; run: boolean; yaw: number; jump?: boolean };

type Vec3 = { x: number; y: number; z: number };

/**
 * Everything that makes the next step differ: feet position, vertical velocity, the horizontal velocity of a
 * knockdown (vx/vz, zero otherwise), grounded flag and the remaining ticks of the knockdown.
 */
export type CharacterState = { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; downTicks: number };

/** Horizontal deceleration of a knocked-down person sliding on the ground (m/s²). */
const KNOCK_FRICTION = 7;
/**
 * A knocked-down (thrown, lying) person moves as a ball of the capsule's radius, its bottom at the feet position: it
 * flies, bounces off walls, trees and cars (KNOCK_BOUNCE of the speed into them; KNOCK_BOUNCE_GROUND off the ground)
 * and slides out, like the body the client shows as a ragdoll. Bikes and people do not stop it.
 */
const KNOCK_BOUNCE = 0.3, KNOCK_BOUNCE_GROUND = 0.15;
/** The thrown ball's query groups: member of bit 0 (so cars, which ignore people, still count), never bikes or people. */
const KNOCK_QUERY_GROUPS = 0x0001_ffe7;
/**
 * A person over a car or a bike (standing on it, or jumping up from it: within CARRY_BELOW under the feet) is carried
 * with it: after every step they are moved and turned exactly as the car moved and turned in that step (as if fixed
 * to it), their own walking on top. Not quite physics (no inertia when it brakes), but nobody slides off a car that
 * drives away.
 */
const CARRY_BELOW = 1.6;
/** What carries: cars and bikes (membership bits). */
const CARRIERS = new Set([CAR_GROUPS >>> 16, BIKE_GROUPS >>> 16]);
/** The thrown ball moves across this far (m) above where it is, clear of the ground under it. */
const THROWN_LIFT = 0.04;
/** Ground: a contact normal at least this steep upwards. */
const GROUND_NY = 0.6;
/** A thrown body falls under real gravity (as the client's ragdoll does), not the character's snappier one. */
const G_THROWN = TUNING.world.gravity;
/**
 * Throwing a crashed rider over an obstacle: the body pivots over the handlebar, so the throw starts VAULT_LIFT (m)
 * higher (chest height); the obstacle's top at most VAULT_MAX_RISE above that; the most upward speed (m/s).
 */
const VAULT_LIFT = 0.45, VAULT_MAX_RISE = 0.9, VAULT_MAX_VY = 6;
/** Share of the forward speed a body keeps going over (the handlebar and the obstacle's edge take the rest). */
export const VAULT_KEEP = 0.7;

const T = TUNING.character;
/** Every step is exactly one fixed world step, so client prediction and server stay in lockstep. */
const DT = TUNING.world.dt;
/** Capsule centre above the feet (the controller keeps a skin gap below the capsule). */
export const CHARACTER_CENTRE = T.height / 2 + T.skin;
const CENTRE = CHARACTER_CENTRE;

/**
 * Walking person: a kinematic capsule moved by Rapier's KinematicCharacterController.
 * All positions are at the feet. Call applyInput once per fixed step, before PhysicsWorld.step().
 */
export class Character {
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private vy = 0;
  private vel: Vec3 = { x: 0, y: 0, z: 0 };
  private enabled = true;
  private grounded = false;
  /** Remaining knockdown steps and the horizontal knock velocity. */
  private downTicks = 0;
  private kvx = 0;
  private kvz = 0;
  /** The car carrying this person through the current step and its pose before it (see CARRY_BELOW). */
  private carrier: { body: RAPIER.RigidBody; t: RAPIER.Vector; q: RAPIER.Rotation } | null = null;
  private readonly offStep: () => void;
  /** Extra displacement for the next applyInput. */
  private pushX = 0;
  private pushZ = 0;

  constructor(private readonly pw: PhysicsWorld, spawn: Vec3) {
    const { rapier: R, world } = pw;
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + CENTRE, spawn.z),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(T.height / 2 - T.radius, T.radius).setCollisionGroups(CHARACTER_GROUPS), this.body,
    );
    this.kcc = world.createCharacterController(T.skin);
    this.kcc.enableAutostep(T.stepMaxHeight, T.stepMinWidth, false);
    this.kcc.enableSnapToGround(T.snapToGround);
    this.kcc.setSlideEnabled(true);
    this.kcc.setMaxSlopeClimbAngle(T.maxSlope);
    this.kcc.setMinSlopeSlideAngle(T.maxSlope);
    this.offStep = onAfterStep(pw, () => this.carry());
  }

  /** Handle of the capsule collider (to map scene-query hits back to the character). */
  get colliderHandle(): number {
    return this.collider.handle;
  }

  applyInput(i: CharacterInput): void {
    if (!this.enabled) return;
    if (this.downTicks > 0) {
      this.thrownStep();
      return;
    }
    let f = i.forward, r = i.right;
    const l = Math.hypot(f, r);
    if (l > 1) { f /= l; r /= l; }
    const speed = i.run ? T.runSpeed : T.walkSpeed;
    const s = Math.sin(i.yaw), c = Math.cos(i.yaw);
    // forward = (sin, cos), right = forward × up = (−cos, sin)
    const vx = (f * s - r * c) * speed;
    const vz = (f * c + r * s) * speed;
    if (i.jump && this.grounded) {
      // moving at something climbable: high enough to get on top of it; otherwise a plain jump
      const sp = Math.hypot(vx, vz);
      this.vy = Math.max(T.jumpSpeed, sp > 0.5 ? this.climbSpeed(vx / sp, vz / sp) : 0);
      this.grounded = false;
    }
    this.vy += T.gravity * DT;
    const p0 = this.body.translation();
    const carrier = (this.carrier = this.carUnder());
    const cb = carrier?.body.handle;

    // over a car or bike, the controller leaves it out (it moves under the feet; colliding with it would push the
    // person around): the feet are kept on its top below instead
    this.kcc.computeColliderMovement(
      this.collider,
      { x: vx * DT + this.pushX, y: this.vy * DT, z: vz * DT + this.pushZ },
      this.pw.rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined,
      carrier ? (c) => c.parent()?.handle !== cb : undefined,
    );
    this.pushX = this.pushZ = 0;
    const m = { ...this.kcc.computedMovement() };
    let onTop = false;
    if (carrier) {
      const top = this.topOf(carrier.body, p0.x + m.x, p0.z + m.z, p0.y - CENTRE + m.y);
      if (top !== null && p0.y - CENTRE + m.y <= top + T.skin) {
        m.y = top + T.skin - (p0.y - CENTRE);
        onTop = true;
      }
    }
    // grounded = standing (not while still rising from a take-off)
    this.grounded = (this.kcc.computedGrounded() || onTop) && this.vy <= 0;
    if (this.grounded) this.vy = 0;
    this.body.setNextKinematicTranslation({ x: p0.x + m.x, y: p0.y + m.y, z: p0.z + m.z });
    // own movement (what the figure animates and turns to; a car carrying it comes on top after the step)
    this.vel = { x: m.x / DT, y: m.y / DT, z: m.z / DT };
  }

  /** The car under the feet (within CARRY_BELOW) and its pose now, or null (see CARRY_BELOW). */
  private carUnder(): { body: RAPIER.RigidBody; t: RAPIER.Vector; q: RAPIER.Rotation } | null {
    const { rapier: R, world } = this.pw;
    const p = this.body.translation(), feet = p.y - CENTRE;
    const hit = world.castRay(new R.Ray({ x: p.x, y: feet + 0.1, z: p.z }, { x: 0, y: -1, z: 0 }), CARRY_BELOW + 0.1, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.collider, this.body,
      (c) => CARRIERS.has(c.collisionGroups() >>> 16));
    const b = hit?.collider.parent();
    return b && !b.isFixed() ? { body: b, t: b.translation(), q: b.rotation() } : null;
  }

  /** Height of the top of `body` (a car, a bike) under (x, z), looking down from a little above `feet`, or null. */
  private topOf(body: RAPIER.RigidBody, x: number, z: number, feet: number): number | null {
    const { rapier: R, world } = this.pw;
    const from = feet + 0.5;
    const hit = world.castRay(new R.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), CARRY_BELOW + 0.5, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.collider, this.body, (c) => c.parent()?.handle === body.handle);
    return hit ? from - hit.timeOfImpact : null;
  }

  /** After a step: moved (and the step's own movement with it) as the carrying car moved, turned about its origin. */
  private carry(): void {
    const c = this.carrier;
    this.carrier = null;
    if (!c || !this.enabled || this.downTicks > 0) return;
    const t1 = c.body.translation(), q1 = c.body.rotation();
    // d = q1 · q0⁻¹ applied to (p − t0), plus t1
    const p = this.body.translation();
    const [ax, ay, az] = rotate(conj(c.q), [p.x - c.t.x, p.y - c.t.y, p.z - c.t.z]);
    const [bx, by, bz] = rotate(q1, [ax, ay, az]);
    const to = { x: t1.x + bx, y: t1.y + by, z: t1.z + bz };
    if (Math.abs(to.x - p.x) + Math.abs(to.y - p.y) + Math.abs(to.z - p.z) < 1e-6) return;
    this.body.setTranslation(to, true);
    this.body.setNextKinematicTranslation(to);
    this.pw.world.propagateModifiedBodyPositionsToColliders();
  }

  /**
   * One step knocked down: the ball (see KNOCK_BOUNCE) moves with the knock velocity under gravity, swept against the
   * world; every contact takes the speed into the surface back with a bounce, ground contact slides it out.
   */
  private thrownStep(): void {
    const { rapier: R, world } = this.pw;
    const rad = T.radius;
    const ball = new R.Ball(rad);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const flags = R.QueryFilterFlags.EXCLUDE_SENSORS;
    const cast = (from: Vec3, d: Vec3) => world.castShape(from, rot, d, ball, 0, 1, false, flags, KNOCK_QUERY_GROUPS, this.collider, this.body);
    const p = this.body.translation();
    let vx = this.kvx, vy = this.vy + G_THROWN * DT, vz = this.kvz;
    // across, a little above the ground (so the ground it lies on is not in the way): walls, trees and cars
    const c = { x: p.x, y: p.y - CENTRE + rad + THROWN_LIFT, z: p.z };
    let left = 1;
    for (let k = 0; k < 3 && left > 1e-4 && (vx !== 0 || vz !== 0); k++) {
      const hit = cast(c, { x: vx * DT * left, y: 0, z: vz * DT * left });
      const t = hit ? hit.time_of_impact : 1;
      c.x += vx * DT * left * t;
      c.z += vz * DT * left * t;
      left *= 1 - t;
      if (!hit) break;
      // the surface's normal towards the ball: normal1, in world space as the ball is not turned (normal2 is in the
      // hit collider's own frame); only its horizontal part matters here
      const n = hit.normal1, h = Math.hypot(n.x, n.z);
      if (h < 1e-3) break;
      const nx = n.x / h, nz = n.z / h, vn = vx * nx + vz * nz;
      if (vn < 0) {
        // a slope it can go up (no bounce), else a wall (bounce)
        const e = n.y > GROUND_NY ? 1 : 1 + KNOCK_BOUNCE;
        vx -= e * vn * nx;
        vz -= e * vn * nz;
      }
    }
    // up and down: lands (bouncing a little when fast), or slides on what it lies on
    let grounded = false;
    const dy = vy * DT - THROWN_LIFT;
    const vh = cast(c, { x: 0, y: dy, z: 0 });
    if (vh) {
      c.y += dy * vh.time_of_impact;
      if (dy < 0) {
        grounded = vh.normal1.y > GROUND_NY;
        vy = vy < -3 ? -vy * KNOCK_BOUNCE_GROUND : 0;
      } else vy = 0; // under something
    } else c.y += dy;
    if (grounded) {
      const sp = Math.hypot(vx, vz), k = sp > 0 ? Math.max(0, sp - KNOCK_FRICTION * DT) / sp : 0;
      vx *= k;
      vz *= k;
    }
    this.kvx = vx; this.kvz = vz; this.vy = vy;
    this.grounded = grounded && vy <= 0;
    const feet = { x: c.x, y: c.y - rad, z: c.z };
    this.body.setNextKinematicTranslation({ x: feet.x, y: feet.y + CENTRE, z: feet.z });
    this.vel = { x: (feet.x - p.x) / DT, y: (feet.y + CENTRE - p.y) / DT, z: (feet.z - p.z) / DT };
    this.pushX = this.pushZ = 0;
    this.downTicks--;
  }

  /**
   * Take-off speed (m/s) to get on top of what is ahead in direction (dx, dz) (unit), or 0 if nothing there is
   * climbable: an obstacle within climbReach whose top lies between a step and climbMax above the feet.
   */
  private climbSpeed(dx: number, dz: number): number {
    const { rapier: R, world } = this.pw;
    const p = this.body.translation(), feet = p.y - CENTRE;
    const flags = R.QueryFilterFlags.EXCLUDE_SENSORS;
    const hit = world.castShape({ x: p.x, y: feet + 0.6, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: 0, z: dz }, new R.Ball(0.2), 0,
      T.radius + T.climbReach, false, flags, undefined, this.collider, this.body);
    if (!hit) return 0;
    // its top, a little beyond the face
    const ahead = hit.time_of_impact + 0.2 + 0.25, from = feet + T.climbMax + 0.3;
    const top = world.castRay(new R.Ray({ x: p.x + dx * ahead, y: from, z: p.z + dz * ahead }, { x: 0, y: -1, z: 0 }), T.climbMax + 0.3, true,
      flags, undefined, this.collider, this.body);
    if (!top) return 0;
    const h = from - top.timeOfImpact - feet;
    if (h < T.stepMaxHeight + 0.15 || h > T.climbMax) return 0;
    return Math.sqrt(2 * -T.gravity * (h + T.climbClear));
  }

  /** A thrown body's start moved and its throw adjusted to go over what is ahead, if low enough: see vaultThrow. */
  throwOver(dx: number, dz: number, speed: number, minUp: number): { speed: number; up: number } {
    const p = this.body.translation();
    const t = vaultThrow(this.pw, { x: p.x, y: p.y - CENTRE, z: p.z }, dx, dz, speed, minUp, this.collider, this.body);
    if (t.lift > 0) this.teleport({ x: p.x, y: p.y - CENTRE + t.lift, z: p.z });
    return t;
  }

  /** Knocked down for `ticks` steps: input is ignored, the person is thrown with velocity v as a ball (see KNOCK_BOUNCE). */
  knock(v: Vec3, ticks: number): void {
    this.kvx = v.x;
    this.kvz = v.z;
    this.vy = v.y;
    this.downTicks = Math.max(0, Math.round(ticks));
    if (v.y > 0) this.grounded = false;
  }

  isDown(): boolean {
    return this.downTicks > 0;
  }

  /** Extra displacement (m) added to the next applyInput, resolved by the controller (collides like walking). */
  push(dx: number, dz: number): void {
    this.pushX += dx;
    this.pushZ += dz;
  }

  saveState(): CharacterState {
    const p = this.position();
    return { x: p.x, y: p.y, z: p.z, vx: this.kvx, vy: this.vy, vz: this.kvz, grounded: this.grounded, downTicks: this.downTicks };
  }

  /** Puts the character back into a saved state (server corrections, replay); pending push is dropped. */
  restoreState(s: CharacterState): void {
    this.teleport({ x: s.x, y: s.y, z: s.z });
    this.vy = s.vy;
    this.kvx = s.vx;
    this.kvz = s.vz;
    this.grounded = s.grounded;
    this.downTicks = s.downTicks;
    this.pushX = this.pushZ = 0;
  }

  /** Feet position. */
  position(): Vec3 {
    const p = this.body.translation();
    return { x: p.x, y: p.y - CENTRE, z: p.z };
  }

  /** Velocity of the last applied step (m/s). */
  velocity(): Vec3 {
    return { ...this.vel };
  }

  /** Standing on ground after the last applied step (false while airborne). */
  isGrounded(): boolean {
    return this.grounded;
  }

  /** Puts the feet at pos immediately (getting out of a car, server corrections); clears velocity. */
  teleport(pos: Vec3): void {
    const t = { x: pos.x, y: pos.y + CENTRE, z: pos.z };
    this.body.setTranslation(t, true);
    this.body.setNextKinematicTranslation(t);
    this.pw.world.propagateModifiedBodyPositionsToColliders(); // queries see the new spot before the next step
    this.vy = 0;
    this.kvx = this.kvz = 0;
    this.downTicks = 0;
    this.pushX = this.pushZ = 0;
    this.vel = { x: 0, y: 0, z: 0 };
  }

  /** Off: the capsule leaves all contacts and queries and ignores input (e.g. while sitting in a car). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.collider.setEnabled(on);
    if (!on) { this.vy = 0; this.kvx = this.kvz = 0; this.downTicks = 0; this.pushX = this.pushZ = 0; this.vel = { x: 0, y: 0, z: 0 }; }
  }

  /** Removes the character (controller, body and its collider) from the world. The instance must not be used afterwards. */
  dispose(): void {
    this.offStep();
    this.pw.world.removeCharacterController(this.kcc);
    this.pw.world.removeRigidBody(this.body);
  }
}

/**
 * A body thrown from `feet` (the bottom of its ball) along (dx, dz) (unit) at `speed`, about to hit something low
 * enough to go over (a car, a post, a bench): it pivots over the handlebar, so it starts `lift` (VAULT_LIFT) higher
 * and flies at VAULT_KEEP × speed, rising fast enough to clear the obstacle's top as it reaches it. Nothing ahead
 * within 3 m, or too high to go over (a wall): (speed, minUp), lift 0. `skip`: the thrown person's own collider/body.
 */
export function vaultThrow(
  pw: PhysicsWorld, feet: Vec3, dx: number, dz: number, speed: number, minUp: number, skipCollider?: RAPIER.Collider, skipBody?: RAPIER.RigidBody,
): { speed: number; up: number; lift: number } {
  const { rapier: R, world } = pw;
  const rad = T.radius;
  const c = { x: feet.x, y: feet.y + rad + VAULT_LIFT, z: feet.z };
  const flags = R.QueryFilterFlags.EXCLUDE_SENSORS;
  const plain = { speed, up: minUp, lift: 0 };
  if (speed < 0.5) return plain;
  const hit = world.castShape(c, { x: 0, y: 0, z: 0, w: 1 }, { x: dx, y: 0, z: dz }, new R.Ball(rad), 0, 3, false, flags, KNOCK_QUERY_GROUPS,
    skipCollider, skipBody);
  if (!hit) return plain;
  const d = hit.time_of_impact, ahead = d + rad + 0.2, from = c.y + VAULT_MAX_RISE + 1;
  const top = world.castRay(new R.Ray({ x: c.x + dx * ahead, y: from, z: c.z + dz * ahead }, { x: 0, y: -1, z: 0 }), VAULT_MAX_RISE + 3, true,
    flags, KNOCK_QUERY_GROUPS, skipCollider, skipBody);
  if (!top) return plain;
  const need = from - top.timeOfImpact + rad + 0.05 - c.y; // the ball's centre above its top
  if (need > VAULT_MAX_RISE) return plain;
  const v = speed * VAULT_KEEP, t = (d + 0.3) / v;
  return { speed: v, up: Math.max(minUp, Math.min(VAULT_MAX_VY, (need - 0.5 * G_THROWN * t * t) / t)), lift: VAULT_LIFT };
}

type Quat = { x: number; y: number; z: number; w: number };
const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
/** v rotated by the unit quaternion q. */
function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const [x, y, z] = v;
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}
