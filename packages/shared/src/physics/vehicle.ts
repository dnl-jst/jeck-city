import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from './tuning';
import { CAR_GROUPS, onBeforeStep, staticWorldFilter, type PhysicsWorld } from './world';

/** throttle −1..1 (negative = reverse / brake while rolling forward), steer −1..1 (positive = right). */
export type VehicleInput = { throttle: number; steer: number; brake: boolean };

/** Pose, velocities (linear, angular) and front-wheel steering angle: enough to replay the car from this instant. */
export type VehicleState = {
  x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number; ax: number; ay: number; az: number; steer: number;
};

const T = TUNING.vehicle;
const KMH = 1 / 3.6;
/** Chassis centre height at rest (approx.: mount height + loaded suspension + wheel radius). */
export const VEHICLE_REST_Y = -T.wheelY + T.suspensionRest - 9.81 / (4 * T.suspensionStiffness) + T.wheelRadius;

/**
 * Car: a dynamic box on Rapier's DynamicRayCastVehicleController (4 ray-cast wheels).
 * The chassis' local +z is forward, so heading h faces (sin h, cos h) in x/z.
 * Unoccupied cars start asleep with the parking brake on; the vehicle controller only
 * runs while the chassis is awake, so ~300 parked cars cost almost nothing until hit.
 */
export class Vehicle {
  readonly chassis: RAPIER.RigidBody;
  private readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  private readonly unsubscribe: () => void;
  private occupied = false;
  private steerAngle = 0;

  /** pose.y is the ground height under the car (default 0); the chassis starts at y + VEHICLE_REST_Y. */
  constructor(private readonly pw: PhysicsWorld, pose: { x: number; z: number; heading: number; y?: number }) {
    const { rapier: R, world } = pw;
    const h = pose.heading;
    this.chassis = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(pose.x, (pose.y ?? 0) + VEHICLE_REST_Y, pose.z)
        .setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) })
        .setLinearDamping(T.linearDamping)
        .setAngularDamping(T.angularDamping)
        .setCcdEnabled(true)
        .setSleeping(true),
    );
    const [hx, hy, hz] = [T.width / 2, T.height / 2, T.length / 2];
    const m = T.mass;
    world.createCollider(
      R.ColliderDesc.cuboid(hx, hy, hz).setMassProperties(
        m,
        { x: 0, y: -T.comDrop, z: 0 },
        { x: (m / 3) * (hy * hy + hz * hz), y: (m / 3) * (hx * hx + hz * hz), z: (m / 3) * (hx * hx + hy * hy) },
        { x: 0, y: 0, z: 0, w: 1 },
      ).setCollisionGroups(CAR_GROUPS),
      this.chassis,
    );

    const c = world.createVehicleController(this.chassis);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (const [x, z] of [[-T.wheelX, T.wheelZ], [T.wheelX, T.wheelZ], [-T.wheelX, -T.wheelZ], [T.wheelX, -T.wheelZ]] as const) {
      const i = c.numWheels();
      c.addWheel({ x, y: T.wheelY, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, T.suspensionRest, T.wheelRadius);
      c.setWheelMaxSuspensionTravel(i, T.suspensionTravel);
      c.setWheelSuspensionStiffness(i, T.suspensionStiffness);
      c.setWheelSuspensionCompression(i, T.suspensionCompression);
      c.setWheelSuspensionRelaxation(i, T.suspensionRelaxation);
      c.setWheelMaxSuspensionForce(i, T.maxSuspensionForce);
      c.setWheelFrictionSlip(i, T.frictionSlip);
      c.setWheelSideFrictionStiffness(i, T.sideFrictionStiffness);
      c.setWheelBrake(i, T.parkingBrake);
    }
    this.ctrl = c;

    // Wheel rays hit the city, other cars and street furniture (fallen lamps); never this chassis, characters (kinematic) or sensors.
    const wheelFilter = staticWorldFilter(true, this.chassis, true);
    this.unsubscribe = onBeforeStep(pw, () => {
      // a kinematic chassis (a car the server streams, see CarPool.follow) is placed, not driven
      if (!this.chassis.isSleeping() && this.chassis.isDynamic()) c.updateVehicle(TUNING.world.dt, undefined, undefined, wheelFilter);
    });
  }

  /** Driver input for one fixed step (TUNING.world.dt); call once per step before PhysicsWorld.step(). Ignored while unoccupied. */
  applyInput(i: VehicleInput): void {
    if (!this.occupied) return;
    const c = this.ctrl;
    const v = this.speed();
    const kmh = Math.abs(v) / KMH;
    const throttle = Math.max(-1, Math.min(1, i.throttle));

    // Speed-sensitive steering, eased towards the target angle.
    const k = Math.max(0, Math.min(1, (kmh - T.steerLowKmh) / (T.steerHighKmh - T.steerLowKmh)));
    const lock = T.steerLowLock + (T.steerHighLock - T.steerLowLock) * k;
    const target = -Math.max(-1, Math.min(1, i.steer)) * lock; // positive wheel angle turns left
    const maxDelta = T.steerRate * TUNING.world.dt;
    this.steerAngle += Math.max(-maxDelta, Math.min(maxDelta, target - this.steerAngle));

    // Throttle against the direction of travel brakes first; only near standstill does it change gear.
    let engine = 0;
    let brake = i.brake ? T.brake : 0;
    if ((throttle > 0 && v < -1) || (throttle < 0 && v > 1)) {
      brake = T.brake;
    } else if (throttle !== 0) {
      const topKmh = throttle > 0 ? T.maxForwardKmh : T.maxReverseKmh;
      const limiter = Math.max(0, Math.min(1, (topKmh - kmh) / T.limiterBandKmh));
      engine = throttle * T.engineForce * limiter;
    } else if (!i.brake) {
      brake = T.coastBrake;
    }

    for (let w = 0; w < 4; w++) {
      c.setWheelEngineForce(w, engine / 4);
      c.setWheelBrake(w, brake);
      c.setWheelSteering(w, w < 2 ? this.steerAngle : 0);
    }
    if (throttle !== 0 || i.steer !== 0 || i.brake) this.chassis.wakeUp();
  }

  /** Chassis centre and orientation. */
  pose(): { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number } {
    const p = this.chassis.translation();
    const q = this.chassis.rotation();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  /** Current steering angle of the front wheels (rad, positive turns left). */
  steer(): number {
    return this.steerAngle;
  }

  saveState(): VehicleState {
    const p = this.chassis.translation(), q = this.chassis.rotation(), v = this.chassis.linvel(), a = this.chassis.angvel();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx: v.x, vy: v.y, vz: v.z, ax: a.x, ay: a.y, az: a.z, steer: this.steerAngle };
  }

  /** Puts the car back into a saved state and wakes it. */
  restoreState(s: VehicleState): void {
    const b = this.chassis;
    b.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
    b.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, true);
    b.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, true);
    b.setAngvel({ x: s.ax, y: s.ay, z: s.az }, true);
    this.steerAngle = s.steer;
    for (let w = 0; w < 2; w++) this.ctrl.setWheelSteering(w, s.steer);
    b.wakeUp();
  }

  /** Number of wheels whose ray currently touches something (0–4). */
  wheelsInContact(): number {
    let n = 0;
    for (let w = 0; w < 4; w++) if (this.ctrl.wheelIsInContact(w)) n++;
    return n;
  }

  /** Signed speed along the heading (m/s); negative when reversing. */
  speed(): number {
    return this.ctrl.currentVehicleSpeed();
  }

  /** Occupied: driver input is applied. Unoccupied: engine off, parking brake on, allowed to fall asleep. */
  setOccupied(on: boolean): void {
    this.occupied = on;
    if (on) {
      this.chassis.wakeUp();
      return;
    }
    this.steerAngle = 0;
    for (let w = 0; w < 4; w++) {
      this.ctrl.setWheelEngineForce(w, 0);
      this.ctrl.setWheelSteering(w, 0);
      this.ctrl.setWheelBrake(w, T.parkingBrake);
    }
  }

  /** Removes the car from the world. The instance must not be used afterwards. */
  dispose(): void {
    this.unsubscribe();
    this.pw.world.removeVehicleController(this.ctrl);
    this.pw.world.removeRigidBody(this.chassis);
  }
}
