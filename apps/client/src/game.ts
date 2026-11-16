import { Quaternion, type Object3D, type PerspectiveCamera, type Scene } from 'three';
import {
  BikeRacks, Character, dismountSpot, FixedStepper, heightAt, ParkedBikes, staticWorldFilter, StreetProps, TUNING, VEHICLE_REST_Y,
  type BikeState, type BikeType, type CharacterVariant, type PhysicsWorld, type RiddenBike, type TerrainGrid, type Vehicle, type WorldManifest,
} from '@nn/shared';
import { BikeRig } from './bikes/rig';
import { BikeView } from './bikes/parked';
import { pickVehicle } from './bikes/pick';
import { RIDE_HINT } from './hud';
import type { GameAudio } from './audio/game-audio';
import { WheelControl, type WheelState } from './audio/wheel-control';
import type { DevCam } from './devparams';
import type { Hud } from './hud';
import type { Input } from './input';
import { canGetOut, DrivenCar, exitSpot, headingOf, nearestEnterableCar, ParkedCars, type CarPose } from './car';
import { angleDelta, PlayerFigure, type Posture } from './player';
import { storeCharacter, storedCharacter, type CharacterModels } from './characters';
import { FollowCamera, FreeFly } from './camera';
import { Ignition } from './ignition';
import { MapMode, type DriveControls } from './map/map-mode';

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;
const DT = TUNING.world.dt;

/**
 * What the game needs from the page: scene and camera, input, HUD, the dev URL parameters, the terrain grid
 * and (optionally) sound.
 */
export type GameContext = {
  scene: Scene; camera: PerspectiveCamera; input: Input; hud: Hud; debug: boolean; devCam: DevCam | null; terrain: TerrainGrid;
  audio?: GameAudio;
  /** Bike and rack model templates (WorldLoader.loadBikeModels); without them bikes still ride, just unseen. */
  bikeModels?: { bikes: ReadonlyMap<BikeType, Object3D>; racks: ReadonlyMap<0 | 1, Object3D> };
  /** Player character models (WorldLoader.characterModels) and the stored choice's template, if it loaded. */
  characters?: CharacterModels;
  character?: Object3D | null;
};

/** Upper-body posture per bike type. */
const POSTURE: Record<BikeType, Posture> = { dutch: 'upright', road: 'race', mtb: 'sport', longjohn: 'upright', trike: 'upright' };
const KMH = 1 / 3.6;

const STATIC_ONLY = staticWorldFilter();

/** Ray length of surfaceY (m): any terrain height lies within it (heights may be negative, below the datum). */
const SURFACE_RAY = 200;

/** Height of the first static surface below (x, fromY, z), or null. */
export function surfaceY(pw: PhysicsWorld, x: number, z: number, fromY: number): number | null {
  const { rapier: R, world: w } = pw;
  const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), SURFACE_RAY, true, undefined, undefined, undefined, undefined, STATIC_ONLY);
  return hit ? fromY - hit.timeOfImpact : null;
}

/** The playable game: walking figure, cars, follow camera; built once world and physics are ready. */
export class Game {
  mode: 'walk' | 'drive' | 'ride' = 'walk';
  flying = false;
  readonly char: Character;
  readonly figure: PlayerFigure;
  readonly cars: ParkedCars;
  readonly driven: DrivenCar;
  /** Tree and lamp colliders; lamps hit hard enough fall over (see takeFallen). */
  readonly props: StreetProps;
  /** Rideable bikes (parked ones are dynamic bodies near the player) and the rack hoops. */
  readonly bikes: ParkedBikes;
  readonly racks: BikeRacks;
  private readonly bikeView: BikeView | null = null;
  private readonly rigs = new Map<BikeType, BikeRig>();
  private ridden: RiddenBike | null = null;
  private riddenId: number | null = null;
  private rig: BikeRig | null = null;
  private prevBike: BikeState | null = null;
  private currBike: BikeState | null = null;
  /** Space pressed on the bike: hop in the next fixed step; a crash in the last steps. */
  private hopPending = false;
  private crashed = false;
  readonly follow: FollowCamera;
  readonly fly: FreeFly;
  /** Door, starter, engine: throttle, radio and lights wait for it. */
  readonly ignition = new Ignition();
  /** Hold R in the car: radio wheel (tap R = next station). */
  readonly wheel = new WheelControl();
  wheelState: WheelState = { open: false, highlighted: null };
  /** The M map: while open, steering input is neutral and mouse/wheel go to the map. */
  readonly map = new MapMode();
  /** Mouse movement and wheel notches for the big map this frame (zero while it is closed). */
  mapInput = { dx: 0, dy: 0, notches: 0 };
  /** Steering input of this frame after the map gate. */
  private ctl: DriveControls = { forward: 0, right: 0, brake: false, run: false };
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
  /** Seconds in the air on foot (for landing sounds). */
  private airTime = 0;
  private readonly tramStops: WorldManifest['tramStops'];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(readonly pw: PhysicsWorld, m: WorldManifest, private readonly ctx: GameContext) {
    const { scene, camera, input, devCam, terrain } = ctx;
    this.tramStops = m.tramStops;
    this.figure = new PlayerFigure(scene);
    this.character = storedCharacter();
    this.figure.setModel(ctx.character ?? null);
    this.driven = new DrivenCar(scene);
    this.fly = new FreeFly(camera, input);
    const spawn = devCam ? { x: devCam.x, z: devCam.z, heading: devCam.yawDeg * DEG } : m.spawn;
    // first surface below a point 3 m above the terrain (sidewalk, kerb or the ground itself)
    const ground = heightAt(terrain, spawn.x, spawn.z);
    const y = surfaceY(pw, spawn.x, spawn.z, ground + 3) ?? ground;
    this.char = new Character(pw, { x: spawn.x, y: y + 0.02, z: spawn.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = spawn.heading;
    this.props = new StreetProps(pw, m.lamps, m.trees, terrain);
    this.cars = new ParkedCars(scene, pw, m.parked, terrain);
    this.racks = new BikeRacks(pw, m.bikeRacks, terrain);
    this.bikes = new ParkedBikes(pw, m.bikes, terrain);
    if (ctx.bikeModels) this.bikeView = new BikeView(scene, ctx.bikeModels.bikes, ctx.bikeModels.racks, this.bikes, m.bikeRacks, this.racks.ys);
    this.bikes.updatePhysics(spawn.x, spawn.z);
    this.follow = new FollowCamera(camera, pw);
    this.follow.yaw = spawn.heading;
    if (devCam) this.follow.pitch = devCam.pitchDeg * DEG;
  }

  /** Where the player is: feet while walking, chassis centre while driving. */
  focus(): Vec3 {
    if (this.mode === 'ride' && this.currBike) return this.currBike;
    return this.mode === 'drive' && this.currPose ? this.currPose : this.currPos;
  }

  /** Type of the bike being ridden, else null. */
  bikeType(): BikeType | null {
    return this.ridden ? this.ridden.type : null;
  }

  /** Ground speed (m/s) of the player or the car. */
  speed(): number {
    if (this.vehicle) return Math.abs(this.vehicle.speed());
    if (this.currBike) return Math.abs(this.currBike.speed);
    const v = this.char.velocity();
    return Math.hypot(v.x, v.z);
  }

  /** Player character shown (CHARACTER_VARIANTS); C switches to the next one that has a model. */
  character: CharacterVariant;

  private switchCharacter(): void {
    const models = this.ctx.characters;
    const variants = models?.variants ?? [];
    if (!models || variants.length < 2) return;
    const next = variants[(variants.indexOf(this.character) + 1) % variants.length]!;
    this.character = next;
    storeCharacter(next);
    this.ctx.hud.flash(next === 'woman' ? 'Figur: Frau' : 'Figur: Mann');
    // the first switch to a figure downloads it; the old one stays until it is there
    models.load(next).then((model) => {
      if (this.character === next) this.figure.setModel(model); // unless switched on meanwhile
    }, (err: unknown) => {
      console.error(err);
      if (this.character === next) this.ctx.hud.flash('Figur konnte nicht geladen werden');
    });
  }

  /** One rendered frame: input, fixed physics steps, poses for rendering. night 0..1 drives the car lights. */
  frame(dt: number, night: number): void {
    const { input, debug, audio } = this.ctx;
    const mouse = input.takeMouse();
    const notches = input.takeWheel();
    if (debug && input.consume('KeyF')) this.toggleFly();
    if (input.consume('KeyN')) audio?.toggleMute();
    if (input.consume('KeyC')) this.switchCharacter();
    if (!this.flying && input.consume('KeyM')) {
      this.map.toggle();
      if (this.map.open) this.closeWheel();
    }
    this.mapInput = this.map.open ? { dx: mouse.dx, dy: mouse.dy, notches } : { dx: 0, dy: 0, notches: 0 };
    if (this.map.takeClosed()) input.clearPresses();
    if (this.flying) {
      this.fly.turn(mouse.dx, mouse.dy);
      this.fly.update(dt);
    } else if (!this.map.open) {
      const rPressed = input.consume('KeyR'); // a press+release between two frames still counts as held once
      if (input.takeBlur()) this.closeWheel(); // window blur: the wheel is cancelled, not committed
      if (this.mode === 'drive' && this.ignition.state !== 'running') this.closeWheel(); // R does nothing until the engine runs
      else if (this.mode === 'drive') {
        this.wheelState = this.wheel.update({ held: input.held('KeyR') || rPressed, dx: mouse.dx, dy: mouse.dy, dt, current: audio?.station ?? null });
        if (this.wheelState.tap) audio?.radioStep(1);
        if (this.wheelState.commit !== undefined) audio?.radioSelect(this.wheelState.commit);
      }
      // while the wheel is open the mouse points at a station instead of turning the camera
      if (!this.wheelState.open) this.follow.turn(mouse.dx, mouse.dy);
      const busy = this.figure.busy; // fallen off: no control until up again
      if (input.consume('Space') && !busy) {
        if (this.mode === 'walk') this.jumpPending = true;
        else if (this.mode === 'ride') this.hopPending = true;
      }
      if (input.consume('KeyH') && this.mode === 'ride') audio?.bell();
      if (input.consume('KeyE') && !busy) {
        if (this.mode === 'walk') this.getIn();
        else if (this.mode === 'ride') this.getOffBike();
        else this.getOut();
      }
      if (this.mode === 'drive') for (let i = 0; i < Math.abs(notches); i++) audio?.radioStep(notches > 0 ? 1 : -1);
    }
    const still = this.flying || this.figure.busy;
    const raw = still ? { forward: 0, right: 0, brake: false, run: false } : { ...input.axes(), brake: input.brake(), run: input.run() };
    const ctl = this.ctl = this.map.gate(raw);
    for (const e of this.ignition.update(dt)) {
      if (e === 'doorClose') audio?.doorClosed();
      else if (e === 'crank') audio?.crank();
      else audio?.engineRunning();
    }
    const throttle = this.ignition.state === 'running' ? ctl.forward : 0;
    this.stepper.advance(dt, () => {
      if (this.mode === 'walk') {
        this.char.applyInput({ forward: ctl.forward, right: ctl.right, run: ctl.run, yaw: this.follow.yaw, jump: this.jumpPending });
        this.jumpPending = false;
      } else if (this.mode === 'ride') {
        if (!this.crashed && this.ridden!.applyInput({ pedal: ctl.forward, steer: ctl.right, sprint: ctl.run, hop: this.hopPending }).crashed) this.crashed = true;
        this.hopPending = false;
      } else {
        this.vehicle!.applyInput({ throttle, steer: ctl.right, brake: ctl.brake });
      }
      this.pw.step();
      this.steps++;
      this.prevPos = this.currPos;
      this.currPos = this.char.position();
      if (this.vehicle) {
        this.prevPose = this.currPose;
        this.currPose = this.vehicle.pose();
      }
      if (this.ridden) {
        this.prevBike = this.currBike;
        this.currBike = this.ridden.state();
      }
    });
    if (this.crashed) this.crash();
    this.bikes.sync();
    this.bikeView?.update(this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.cars.sync();
    this.cars.updateVisibility(this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.proximityAge += dt;
    if (this.proximityAge > 0.5) {
      this.proximityAge = 0;
      const f = this.focus();
      this.cars.updateProximity(f.x, f.z);
      this.bikes.updatePhysics(f.x, f.z);
    }
    this.render(dt, night);
  }

  private render(dt: number, night: number): void {
    const { audio } = this.ctx;
    const a = this.stepper.alpha;
    if (this.mode === 'walk') {
      const p = lerp3(this.prevPos, this.currPos, a);
      const v = this.char.velocity();
      this.figure.update(p.x, p.y, p.z, v, dt);
      if (!this.flying) this.follow.update(p, 0, dt);
      const grounded = this.char.isGrounded();
      if (!grounded) this.airTime += dt;
      audio?.walk({ speed: Math.hypot(v.x, v.z), grounded, airTime: this.airTime }, dt);
      if (grounded) this.airTime = 0;
    } else if (this.mode === 'ride' && this.currBike && this.rig) {
      const prev = this.prevBike ?? this.currBike, cur = this.currBike;
      const s: BikeState = { ...cur, ...lerp3(prev, cur, a), heading: prev.heading + angleDelta(prev.heading, cur.heading) * a };
      const rig = this.rig;
      rig.update(s, this.ridden!.lean(), dt);
      rig.setLights(night);
      this.figure.ride(rig.localPoint('seat'), [rig.localPoint('grip_l'), rig.localPoint('grip_r')],
        [rig.localPoint('pedal_l'), rig.localPoint('pedal_r')], POSTURE[rig.type]);
      if (!this.flying) this.follow.update(s, s.heading, dt);
      audio?.ride({ speed: Math.abs(s.speed), pedalling: this.ctl.forward > 0 && s.speed > 0.3, grounded: s.grounded }, dt);
    } else if (this.currPose) {
      const prev = this.prevPose ?? this.currPose;
      const pose = { ...lerp3(prev, this.currPose, a), ...slerpQ(this.qa, this.qb, prev, this.currPose, a) };
      this.driven.setPose(pose);
      const braking = this.ctl.brake || (this.ctl.forward < 0 && this.vehicle!.speed() > 1);
      this.driven.setLights(night, braking, this.ignition.lightPower(Math.random));
      if (!this.flying) this.follow.update(pose, headingOf(pose), dt);
      this.driven.updateGlare(this.ctx.camera, this.occluded, dt);
      if (audio) {
        // velocity along / across the car's heading (forward = (sin h, cos h))
        const h = headingOf(pose), v = this.vehicle!.chassis.linvel();
        const s = Math.sin(h), c = Math.cos(h);
        audio.drive({
          forward: v.x * s + v.z * c, lateral: v.x * c - v.z * s, vx: v.x, vz: v.z,
          throttle: this.ctl.forward, handbrake: this.ctl.brake,
        }, dt);
      }
    }
    if (audio) {
      const f = this.focus();
      audio.listener(f.x, f.z, this.follow.yaw, nearestStop(this.tramStops, f.x, f.z), dt);
    }
  }

  /** Line of sight between two points blocked by static world geometry (lamp glare vs. camera). */
  private readonly occluded = (from: Vec3, to: Vec3): boolean => {
    const { rapier: R, world: w } = this.pw;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return false;
    return w.castRay(new R.Ray(from, { x: dx / d, y: dy / d, z: dz / d }), d, true, undefined, undefined, undefined, undefined, STATIC_ONLY) !== null;
  };

  private toggleFly(): void {
    this.flying = !this.flying;
    this.ctx.input.clearPresses();
    this.closeWheel();
    if (this.flying) this.fly.setHeading(this.follow.yaw, this.follow.pitch);
    else this.follow.snap();
  }

  private getIn(): void {
    const id = nearestEnterableCar(this.currPos, this.cars.candidates());
    const bike = this.bikes.nearestMountable(this.currPos);
    const choice = pickVehicle(this.currPos, this.figure.heading, id === null ? null : this.cars.poses[id]!, bike === null ? null : this.bikes.poses[bike]!);
    if (choice === 'bike') {
      this.mountBike(bike!);
      return;
    }
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
    this.ignition.start();
    this.ctx.audio?.enterCar();
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
    this.char.teleport({ x: spot.x, y: (surfaceY(this.pw, spot.x, spot.z, pose.y + 1) ?? heightAt(this.ctx.terrain, spot.x, spot.z)) + 0.02, z: spot.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = heading;
    this.figure.visible = true;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.ignition.stop();
    this.closeWheel();
    this.ctx.audio?.exitCar();
  }

  private mountBike(id: number): void {
    this.ridden = this.bikes.mount(id);
    this.riddenId = id;
    this.currBike = this.prevBike = this.ridden.state();
    this.crashed = false;
    this.hopPending = this.jumpPending = false;
    this.char.setEnabled(false);
    const type = this.ridden.type;
    this.rig = this.rigFor(type);
    if (this.rig) {
      this.rig.setColor(this.bikes.colors[id]!);
      this.rig.snapLean();
      this.ctx.scene.add(this.rig.root);
      this.rig.leanGroup.add(this.figure.group);
    }
    this.follow.setDriving(true, this.currBike.heading, 'bike');
    this.mode = 'ride';
    this.ctx.hud.setHint(RIDE_HINT);
    this.ctx.audio?.mountBike();
  }

  /** E on the bike: step off to the side (slow) or jump off and let the bike roll on (fast). */
  private getOffBike(): void {
    const s = this.ridden!.state();
    const spot = dismountSpot(s, (x, z) => this.bikes.canStepOff(s, x, z));
    if (!spot) {
      this.ctx.hud.flash('Hier kannst du nicht absteigen');
      return;
    }
    if (Math.abs(s.speed) < TUNING.bike.dismountJumpKmh * KMH) this.ridden!.restore({ ...s, speed: 0 });
    this.leaveBike(spot, s);
  }

  /** Crashed into something: fall off next to the bike, which stays where it is. */
  private crash(): void {
    this.crashed = false;
    const s = this.ridden!.state();
    this.ridden!.restore({ ...s, speed: 0 });
    // nowhere free to the side or behind (squeezed against a wall): fall where the bike is, never through the wall
    const spot = dismountSpot(s, (x, z) => this.bikes.canStepOff(s, x, z)) ?? { x: s.x, z: s.z };
    this.leaveBike(spot, s);
    this.figure.fall(s.heading);
    this.ctx.audio?.crashBike();
  }

  private leaveBike(spot: { x: number; z: number }, s: BikeState): void {
    this.bikes.dismount(this.riddenId!, this.ridden!);
    this.ridden = null;
    this.riddenId = null;
    this.currBike = this.prevBike = null;
    if (this.rig) {
      this.ctx.scene.remove(this.rig.root);
      this.rig.setLights(0);
    }
    this.rig = null;
    this.ctx.scene.add(this.figure.group);
    this.char.setEnabled(true);
    this.char.teleport({ x: spot.x, y: (surfaceY(this.pw, spot.x, spot.z, s.y + 1) ?? heightAt(this.ctx.terrain, spot.x, spot.z)) + 0.02, z: spot.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = s.heading;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.ctx.hud.setHint('');
    this.ctx.audio?.dismountBike();
  }

  /** One rig (a clone of the model) per bike type, made on first use. */
  private rigFor(type: BikeType): BikeRig | null {
    let rig = this.rigs.get(type);
    const model = this.ctx.bikeModels?.bikes.get(type);
    if (!rig && model) {
      rig = new BikeRig(model.clone(true), type);
      this.rigs.set(type, rig);
    }
    return rig ?? null;
  }

  private closeWheel(): void {
    this.wheel.cancel(this.ctx.input.held('KeyR'));
    this.wheelState = { open: false, highlighted: this.wheelState.highlighted }; // keep the slot for the fade-out
  }

  /**
   * Exit spot test: nothing static or dynamic between the car's centre and the spot (ray at 1 m, so no
   * stepping out through a wall into a building), and a standing capsule at the spot touches nothing.
   */
  private exitFree(car: CarPose, x: number, z: number): boolean {
    const { rapier: R, world: w } = this.pw;
    const chassis = this.vehicle!.chassis;
    const solid = staticWorldFilter(true, chassis, true); // city, other cars, trees and lamps; not this car or the player
    const dx = x - car.x, dz = z - car.z, d = Math.hypot(dx, dz);
    const y = car.y + 0.1;
    const reach = d + TUNING.character.radius;
    if (w.castRay(new R.Ray({ x: car.x, y, z: car.z }, { x: dx / d, y: 0, z: dz / d }), reach, true, undefined, undefined, undefined, undefined, solid)) return false;
    const T = TUNING.character;
    const capsule = new R.Capsule(T.height / 2 - T.radius, T.radius);
    // bottom 0.3 m above the road: clears kerbs, touches walls, posts and other cars
    // (from the higher of the car's ground and the terrain at the spot, so cross-slopes don't block it)
    const bottom = Math.max(car.y - VEHICLE_REST_Y, heightAt(this.ctx.terrain, x, z) + 0.12) + 0.3;
    const centre = { x, y: bottom + T.height / 2, z };
    return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, solid) === null;
  }
}

/** The tram stop closest to (x, z) and its distance, or null if there is none. */
function nearestStop(stops: WorldManifest['tramStops'], x: number, z: number): { x: number; z: number; dist: number } | null {
  let best: { x: number; z: number; dist: number } | null = null;
  for (const st of stops) {
    const dist = Math.hypot(st.x - x, st.z - z);
    if (!best || dist < best.dist) best = { x: st.x, z: st.z, dist };
  }
  return best;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function slerpQ(qa: Quaternion, qb: Quaternion, a: CarPose, b: CarPose, t: number): { qx: number; qy: number; qz: number; qw: number } {
  qa.set(a.qx, a.qy, a.qz, a.qw).slerp(qb.set(b.qx, b.qy, b.qz, b.qw), t);
  return { qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w };
}
