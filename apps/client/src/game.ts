import { Quaternion, type PerspectiveCamera, type Scene } from 'three';
import {
  Character, FixedStepper, staticWorldFilter, TUNING, VEHICLE_REST_Y, type PhysicsWorld, type Vehicle, type WorldManifest,
} from '@nn/shared';
import type { DevCam } from './devparams';
import type { Hud } from './hud';
import type { Input } from './input';
import { canGetOut, DrivenCar, exitSpot, headingOf, nearestEnterableCar, ParkedCars, type CarPose } from './car';
import { PlayerFigure } from './player';
import { FollowCamera, FreeFly } from './camera';

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;
const DT = TUNING.world.dt;

/** What the game needs from the page: scene and camera, input, HUD and the dev URL parameters. */
export type GameContext = { scene: Scene; camera: PerspectiveCamera; input: Input; hud: Hud; debug: boolean; devCam: DevCam | null };

const STATIC_ONLY = staticWorldFilter();

/** Height of the first static surface below (x, fromY, z), or null. */
export function surfaceY(pw: PhysicsWorld, x: number, z: number, fromY: number): number | null {
  const { rapier: R, world: w } = pw;
  const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), fromY + 5, true, undefined, undefined, undefined, undefined, STATIC_ONLY);
  return hit ? fromY - hit.timeOfImpact : null;
}

/** The playable game: walking figure, cars, follow camera; built once world and physics are ready. */
export class Game {
  mode: 'walk' | 'drive' = 'walk';
  flying = false;
  readonly char: Character;
  readonly figure: PlayerFigure;
  readonly cars: ParkedCars;
  readonly driven: DrivenCar;
  readonly follow: FollowCamera;
  readonly fly: FreeFly;
  private readonly stepper = new FixedStepper(DT, 5);
  /** Fixed physics steps taken so far (tests wait on simulation time, not on the wall clock). */
  steps = 0;
  private vehicle: Vehicle | null = null;
  private carColor = 0;
  /** Physics state before and after the last step, blended by stepper.alpha for rendering. */
  private prevPos: Vec3;
  private currPos: Vec3;
  private prevPose: CarPose | null = null;
  private currPose: CarPose | null = null;
  private proximityAge = Infinity;
  /** Space pressed on foot: jump in the next fixed step. */
  private jumpPending = false;
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(readonly pw: PhysicsWorld, m: WorldManifest, private readonly ctx: GameContext) {
    const { scene, camera, input, devCam } = ctx;
    this.figure = new PlayerFigure(scene);
    this.driven = new DrivenCar(scene);
    this.fly = new FreeFly(camera, input);
    const spawn = devCam ? { x: devCam.x, z: devCam.z, heading: devCam.yawDeg * DEG } : m.spawn;
    const y = surfaceY(pw, spawn.x, spawn.z, 3) ?? 0;
    this.char = new Character(pw, { x: spawn.x, y: y + 0.02, z: spawn.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = spawn.heading;
    this.cars = new ParkedCars(scene, pw, m.parked);
    this.follow = new FollowCamera(camera, pw);
    this.follow.yaw = spawn.heading;
    if (devCam) this.follow.pitch = devCam.pitchDeg * DEG;
  }

  /** Where the player is: feet while walking, chassis centre while driving. */
  focus(): Vec3 {
    return this.mode === 'drive' && this.currPose ? this.currPose : this.currPos;
  }

  /** Ground speed (m/s) of the player or the car. */
  speed(): number {
    if (this.vehicle) return Math.abs(this.vehicle.speed());
    const v = this.char.velocity();
    return Math.hypot(v.x, v.z);
  }

  /** One rendered frame: input, fixed physics steps, poses for rendering. night 0..1 drives the car lights. */
  frame(dt: number, night: number): void {
    const { input, debug } = this.ctx;
    const mouse = input.takeMouse();
    if (debug && input.consume('KeyF')) this.toggleFly();
    if (this.flying) {
      this.fly.turn(mouse.dx, mouse.dy);
      this.fly.update(dt);
    } else {
      this.follow.turn(mouse.dx, mouse.dy);
      if (input.consume('Space') && this.mode === 'walk') this.jumpPending = true;
      if (input.consume('KeyE')) {
        if (this.mode === 'walk') this.getIn();
        else this.getOut();
      }
    }
    const steer = this.flying ? { forward: 0, right: 0 } : input.axes();
    this.stepper.advance(dt, () => {
      if (this.mode === 'walk') {
        this.char.applyInput({ forward: steer.forward, right: steer.right, run: input.run() && !this.flying, yaw: this.follow.yaw, jump: this.jumpPending });
        this.jumpPending = false;
      } else {
        this.vehicle!.applyInput({ throttle: steer.forward, steer: steer.right, brake: input.brake() && !this.flying });
      }
      this.pw.step();
      this.steps++;
      this.prevPos = this.currPos;
      this.currPos = this.char.position();
      if (this.vehicle) {
        this.prevPose = this.currPose;
        this.currPose = this.vehicle.pose();
      }
    });
    this.cars.sync();
    this.cars.updateVisibility(this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.proximityAge += dt;
    if (this.proximityAge > 0.5) {
      this.proximityAge = 0;
      const f = this.focus();
      this.cars.updateProximity(f.x, f.z);
    }
    this.render(dt, night);
  }

  private render(dt: number, night: number): void {
    const input = this.ctx.input;
    const a = this.stepper.alpha;
    if (this.mode === 'walk') {
      const p = lerp3(this.prevPos, this.currPos, a);
      const v = this.char.velocity();
      this.figure.update(p.x, p.y, p.z, v, dt);
      if (!this.flying) this.follow.update(p, 0, dt);
    } else if (this.currPose) {
      const prev = this.prevPose ?? this.currPose;
      const pose = { ...lerp3(prev, this.currPose, a), ...slerpQ(this.qa, this.qb, prev, this.currPose, a) };
      this.driven.setPose(pose);
      const braking = input.brake() || (input.axes().forward < 0 && this.vehicle!.speed() > 1);
      this.driven.setLights(night, braking && !this.flying);
      if (!this.flying) this.follow.update(pose, headingOf(pose), dt);
    }
  }

  private toggleFly(): void {
    this.flying = !this.flying;
    this.ctx.input.clearPresses();
    if (this.flying) this.fly.setHeading(this.follow.yaw, this.follow.pitch);
    else this.follow.snap();
  }

  private getIn(): void {
    const id = nearestEnterableCar(this.currPos, this.cars.candidates());
    if (id === null) return;
    this.vehicle = this.cars.enter(id);
    this.jumpPending = false;
    this.carColor = this.cars.colors[id]!;
    this.currPose = this.prevPose = this.vehicle.pose();
    this.char.setEnabled(false);
    this.figure.visible = false;
    this.driven.setPose(this.currPose);
    this.driven.show(this.carColor);
    this.follow.setDriving(true, headingOf(this.currPose));
    this.mode = 'drive';
  }

  private getOut(): void {
    if (!canGetOut(this.vehicle!.speed())) {
      this.ctx.hud.flash('Erst anhalten');
      return;
    }
    const pose = this.vehicle!.pose();
    const heading = headingOf(pose);
    const spot = exitSpot({ x: pose.x, z: pose.z, heading }, (x, z) => this.exitFree(pose, x, z));
    if (!spot) {
      this.ctx.hud.flash('Hier kannst du nicht aussteigen');
      return;
    }
    this.cars.exit();
    this.vehicle = null;
    this.currPose = this.prevPose = null;
    this.driven.hide();
    this.char.setEnabled(true);
    this.char.teleport({ x: spot.x, y: (surfaceY(this.pw, spot.x, spot.z, pose.y + 1) ?? 0) + 0.02, z: spot.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = heading;
    this.figure.visible = true;
    this.follow.setDriving(false);
    this.mode = 'walk';
  }

  /**
   * Exit spot test: nothing static or dynamic between the car's centre and the spot (ray at 1 m, so no
   * stepping out through a wall into a building), and a standing capsule at the spot touches nothing.
   */
  private exitFree(car: CarPose, x: number, z: number): boolean {
    const { rapier: R, world: w } = this.pw;
    const chassis = this.vehicle!.chassis;
    const solid = staticWorldFilter(true, chassis); // city and other cars, not this car or the player
    const dx = x - car.x, dz = z - car.z, d = Math.hypot(dx, dz);
    const y = car.y + 0.1;
    const reach = d + TUNING.character.radius;
    if (w.castRay(new R.Ray({ x: car.x, y, z: car.z }, { x: dx / d, y: 0, z: dz / d }), reach, true, undefined, undefined, undefined, undefined, solid)) return false;
    const T = TUNING.character;
    const capsule = new R.Capsule(T.height / 2 - T.radius, T.radius);
    // bottom 0.3 m above the road: clears kerbs, touches walls, posts and other cars
    const centre = { x, y: car.y - VEHICLE_REST_Y + 0.3 + T.height / 2, z };
    return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, solid) === null;
  }
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function slerpQ(qa: Quaternion, qb: Quaternion, a: CarPose, b: CarPose, t: number): { qx: number; qy: number; qz: number; qw: number } {
  qa.set(a.qx, a.qy, a.qz, a.qw).slerp(qb.set(b.qx, b.qy, b.qz, b.qw), t);
  return { qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w };
}
