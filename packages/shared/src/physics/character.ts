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

/** Horizontal deceleration of a knocked-down person on the ground (m/s²). */
const KNOCK_FRICTION = 6;

const T = TUNING.character;
/** Every step is exactly one fixed world step, so client prediction and server stay in lockstep. */
const DT = TUNING.world.dt;
/** Capsule centre above the feet (the controller keeps a skin gap below the capsule). */
const CENTRE = T.height / 2 + T.skin;

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
    let vx = 0, vz = 0;
    if (this.downTicks > 0) {
      // knocked down: input is ignored, the knock velocity slides out with ground friction
      vx = this.kvx;
      vz = this.kvz;
      if (this.grounded) {
        const sp = Math.hypot(vx, vz);
        const k = sp > 0 ? Math.max(0, sp - KNOCK_FRICTION * DT) / sp : 0;
        this.kvx *= k;
        this.kvz *= k;
      }
    } else {
      let f = i.forward, r = i.right;
      const l = Math.hypot(f, r);
      if (l > 1) { f /= l; r /= l; }
      const speed = i.run ? T.runSpeed : T.walkSpeed;
      const s = Math.sin(i.yaw), c = Math.cos(i.yaw);
      // forward = (sin, cos), right = forward × up = (−cos, sin)
      vx = (f * s - r * c) * speed;
      vz = (f * c + r * s) * speed;
      if (i.jump && this.grounded) {
        this.vy = T.jumpSpeed;
        this.grounded = false;
      }
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
    if (this.downTicks > 0) this.downTicks--;
  }

  /** Knocked down for `ticks` steps: input is ignored and the capsule flies/slides with velocity v (gravity and ground friction act). */
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
