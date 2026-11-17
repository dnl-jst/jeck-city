import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from './tuning';
import { CHARACTER_GROUPS, type PhysicsWorld } from './world';

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
/** Ground: a contact normal at least this steep upwards. */
const GROUND_NY = 0.6;

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
      this.vy = T.jumpSpeed;
      this.grounded = false;
    }
    this.vy += T.gravity * DT;

    this.kcc.computeColliderMovement(
      this.collider,
      { x: vx * DT + this.pushX, y: this.vy * DT, z: vz * DT + this.pushZ },
      this.pw.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    this.pushX = this.pushZ = 0;
    const m = this.kcc.computedMovement();
    // grounded = standing (not while still rising from a take-off)
    this.grounded = this.kcc.computedGrounded() && this.vy <= 0;
    if (this.grounded) this.vy = 0;
    const p = this.body.translation();
    this.body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
    this.vel = { x: m.x / DT, y: m.y / DT, z: m.z / DT };
  }

  /**
   * One step knocked down: the ball (see KNOCK_BOUNCE) moves with the knock velocity under gravity, swept against the
   * world; every contact takes the speed into the surface back with a bounce, ground contact slides it out.
   */
  private thrownStep(): void {
    const { rapier: R, world } = this.pw;
    const rad = T.radius;
    const ball = new R.Ball(rad);
    const p = this.body.translation();
    let cx = p.x, cy = p.y - CENTRE + rad, cz = p.z;
    let vx = this.kvx, vy = this.vy + T.gravity * DT, vz = this.kvz;
    let grounded = false;
    let left = DT;
    for (let k = 0; k < 4 && left > 1e-6; k++) {
      const hit = world.castShape({ x: cx, y: cy, z: cz }, { x: 0, y: 0, z: 0, w: 1 }, { x: vx, y: vy, z: vz }, ball, T.skin, left, false,
        R.QueryFilterFlags.EXCLUDE_SENSORS, KNOCK_QUERY_GROUPS, this.collider, this.body);
      const t = hit ? Math.min(left, hit.time_of_impact) : left;
      cx += vx * t; cy += vy * t; cz += vz * t;
      left -= t;
      if (!hit) break;
      // the surface's normal towards the ball: normal1, in world space as the ball is not turned (normal2 is in the hit
      // collider's own frame)
      const n = hit.normal1, vn = vx * n.x + vy * n.y + vz * n.z;
      const ground = n.y > GROUND_NY;
      if (ground) grounded = true;
      if (vn < 0) {
        const e = 1 + (ground ? KNOCK_BOUNCE_GROUND : KNOCK_BOUNCE);
        vx -= e * vn * n.x; vy -= e * vn * n.y; vz -= e * vn * n.z;
      }
      if (ground && Math.abs(vy) < 1) vy = 0; // resting on it, not hopping
    }
    if (grounded) {
      const sp = Math.hypot(vx, vz), k = sp > 0 ? Math.max(0, sp - KNOCK_FRICTION * DT) / sp : 0;
      vx *= k;
      vz *= k;
    }
    this.kvx = vx; this.kvz = vz; this.vy = grounded && vy <= 0 ? 0 : vy;
    this.grounded = grounded;
    const feet = { x: cx, y: cy - rad, z: cz };
    this.body.setNextKinematicTranslation({ x: feet.x, y: feet.y + CENTRE, z: feet.z });
    this.vel = { x: (feet.x - p.x) / DT, y: (feet.y + CENTRE - p.y) / DT, z: (feet.z - p.z) / DT };
    this.pushX = this.pushZ = 0;
    this.downTicks--;
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
    this.pw.world.removeCharacterController(this.kcc);
    this.pw.world.removeRigidBody(this.body);
  }
}
