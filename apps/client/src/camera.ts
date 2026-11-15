import { Euler, Vector3, type PerspectiveCamera } from 'three';
import { staticWorldFilter, VEHICLE_REST_Y, type PhysicsWorld } from '@nn/shared';
import type { Input } from './input';
import { angleDelta } from './player';

/** Third-person offsets (m): behind and above the feet on foot; behind and above the road in the car. */
export const CAMERA_WALK = { back: 5, up: 2.3, pivot: 1.5 };
/** Vertical field of view (degrees). */
export const CAMERA_FOV = 60;
export const CAMERA_DRIVE = { back: 7, up: 2.5, pivot: 1.7 };
/** On a bike: closer and lower than on foot; target y is the ground under the wheels. */
export const CAMERA_RIDE = { back: 4.2, up: 1.9, pivot: 1.3 };
const MOUSE = 0.0025;
const PITCH_MIN = -1.1, PITCH_MAX = 0.55;
/** Closest the camera may get to the pivot when a wall is in the way (m). */
const MIN_DIST = 0.9;
/** The camera only collides with the static city (not cars, not the player). */
const STATIC_ONLY = staticWorldFilter();

/**
 * Third-person follow camera. yaw uses the heading convention (looks along (sin yaw, cos yaw));
 * pitch < 0 looks down. The camera orbits a pivot above the target and is pulled in front of walls
 * found by a ray cast against the physics world (dynamic and kinematic bodies are ignored).
 */
export class FollowCamera {
  yaw = 0;
  pitch = -0.12;
  private readonly pivot = new Vector3();
  private placed = false;
  private dist: number = CAMERA_WALK.back;
  /** In the car: smoothed car heading the camera trails, plus a mouse offset that drifts back to 0. */
  private carYaw = 0;
  private lookOffset = 0;
  private idle = 0;
  private driving = false;
  /** While driving: a car (target = chassis centre) or a bike (target = ground under the wheels). */
  private vehicle: 'car' | 'bike' = 'car';
  private readonly look = new Vector3();

  constructor(private readonly cam: PerspectiveCamera, private readonly pw: PhysicsWorld) {}

  /** Mouse look (px). */
  turn(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.driving) {
      this.lookOffset -= dx * MOUSE;
      this.idle = 0;
    } else this.yaw -= dx * MOUSE;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch - dy * MOUSE));
  }

  /** Switches between walk and drive framing (car or bike); getting in starts behind the vehicle. */
  setDriving(on: boolean, carHeading = 0, vehicle: 'car' | 'bike' = 'car'): void {
    this.vehicle = vehicle;
    if (on && !this.driving) {
      this.carYaw = carHeading;
      this.lookOffset = angleDelta(carHeading, this.yaw);
    }
    this.driving = on;
  }

  /** Puts the camera right behind the target without smoothing (spawn, teleports). */
  snap(): void {
    this.placed = false;
  }

  /** target = feet (walking), chassis centre (car) or ground under the wheels (bike), with the vehicle heading. */
  update(target: { x: number; y: number; z: number }, carHeading: number, dt: number): void {
    const bike = this.driving && this.vehicle === 'bike';
    const o = bike ? CAMERA_RIDE : this.driving ? CAMERA_DRIVE : CAMERA_WALK;
    const groundY = this.driving && !bike ? target.y - VEHICLE_REST_Y : target.y;
    if (this.driving) {
      this.carYaw += angleDelta(this.carYaw, carHeading) * Math.min(1, dt * 3);
      this.idle += dt;
      if (this.idle > 1.5) this.lookOffset *= Math.exp(-dt * 1.5);
      this.yaw = this.carYaw + this.lookOffset;
    }
    const want = { x: target.x, y: groundY + o.pivot, z: target.z };
    if (!this.placed) {
      this.pivot.set(want.x, want.y, want.z);
      this.dist = o.back;
      this.placed = true;
    } else {
      const k = 1 - Math.exp(-dt * (this.driving ? 10 : 16));
      this.pivot.x += (want.x - this.pivot.x) * k;
      this.pivot.y += (want.y - this.pivot.y) * k;
      this.pivot.z += (want.z - this.pivot.z) * k;
    }
    // orbit: back along the view direction, lifted so that at pitch 0 the camera is o.up above the ground
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw) * cp, fy = sp, fz = Math.cos(this.yaw) * cp;
    const lift = o.up - o.pivot;
    const bx = -fx * o.back, by = -fy * o.back + lift, bz = -fz * o.back;
    const len = Math.hypot(bx, by, bz);
    const allowed = this.clearDistance(this.pivot, bx / len, by / len, bz / len, len);
    if (allowed < this.dist) this.dist = allowed;
    else this.dist += (allowed - this.dist) * Math.min(1, dt * 3);
    const s = this.dist / len;
    this.cam.position.set(this.pivot.x + bx * s, this.pivot.y + by * s, this.pivot.z + bz * s);
    this.look.set(this.cam.position.x + fx, this.cam.position.y + fy, this.cam.position.z + fz);
    this.cam.lookAt(this.look);
  }

  /** How far the camera may sit from p along (dx, dy, dz) before hitting static geometry (≤ max). */
  private clearDistance(p: Vector3, dx: number, dy: number, dz: number, max: number): number {
    const { rapier: R, world } = this.pw;
    const hit = world.castRay(new R.Ray({ x: p.x, y: p.y, z: p.z }, { x: dx, y: dy, z: dz }), max + 0.3, true, undefined, undefined, undefined, undefined, STATIC_ONLY);
    return hit ? Math.max(MIN_DIST, Math.min(max, hit.timeOfImpact - 0.3)) : max;
  }
}

/** Dev free-fly camera (`?debug=1`, toggled with F): WASD, mouse look, Q/E down/up, Shift fast. */
export class FreeFly {
  /** three.js yaw (camera looks along −z at 0). */
  yaw = 0;
  pitch = 0;

  constructor(private readonly cam: PerspectiveCamera, private readonly input: Input) {}

  /** Points the camera along a manifest heading h (forward = (sin h, cos h) in x/z). */
  setHeading(h: number, pitch = 0): void {
    // camera looks along -Z at yaw 0; rotating by yaw gives forward (-sin yaw, -cos yaw)
    this.yaw = h + Math.PI;
    this.pitch = pitch;
  }

  /** Heading (manifest convention) the camera looks along. */
  get heading(): number {
    return this.yaw - Math.PI;
  }

  turn(dx: number, dy: number): void {
    this.yaw -= dx * MOUSE;
    this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch - dy * MOUSE));
  }

  update(dt: number): void {
    this.cam.quaternion.setFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const k = (c: string) => (this.input.held(c) ? 1 : 0);
    const a = this.input.axes();
    const speed = (this.input.run() ? 40 : 6) * dt;
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(this.cam.quaternion);
    this.cam.position.addScaledVector(fwd, a.forward * speed).addScaledVector(right, a.right * speed);
    this.cam.position.y += (k('KeyE') - k('KeyQ')) * speed;
  }
}
