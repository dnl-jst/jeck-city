import {
  ACESFilmicToneMapping, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Quaternion, Scene, Timer, WebGLRenderer,
} from 'three';
import {
  Character, createPhysicsWorld, decodeCollision, FixedStepper, localToWgs84, parseTimeOverride, sunState, TUNING, VEHICLE_REST_Y,
  type PhysicsWorld, type SunState, type Vehicle, type WorldManifest,
} from '@nn/shared';
import { FetchError, NoWebGLError } from './errors';
import { Hud } from './hud';
import { WorldLoader } from './loader';
import { parseCamParam, withDateParam } from './devparams';
import { Lighting } from './lighting';
import { Props } from './props';
import { DebugOverlay } from './debug';
import { attachInput, Input } from './input';
import { DrivenCar, exitSpot, headingOf, nearestEnterableCar, ParkedCars, type CarPose } from './car';
import { PlayerFigure } from './player';
import { FollowCamera, FreeFly } from './camera';

type Vec3 = { x: number; y: number; z: number };

declare global {
  interface Window {
    __nnReady?: boolean | 'error';
    /** Dev: the renderer's per-frame statistics (draw calls, triangles). */
    __nnInfo?: () => { calls: number; triangles: number };
    /** Dev/tests: what the player is doing, and the height of the first static surface below (x, 100, z). */
    __nnState?: () => { mode: 'walk' | 'drive'; flying: boolean; x: number; y: number; z: number; speed: number };
    __nnSurfaceY?: (x: number, z: number) => number | null;
  }
}

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
// dev hooks: ?time=HH:MM overrides the wall-clock time, ?date=YYYY-MM-DD the date (sun position)
const timeOverride = params.get('time') ?? undefined;
const dateOverride = params.get('date');
const currentSun = (): SunState => sunState(withDateParam(new Date(), dateOverride), timeOverride);
// dev hook: ?cam=x,y,z,yawDeg,pitchDeg spawns the player at x/z facing yaw (manifest heading convention), camera pitch
const devCam = parseCamParam(params.get('cam'));
const DEG = Math.PI / 180;
const DT = TUNING.world.dt;

const canvas = document.getElementById('game') as HTMLCanvasElement;
let renderer: WebGLRenderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, reversedDepthBuffer: true });
} catch (err) {
  throw new NoWebGLError(String(err));
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// PCFSoftShadowMap was removed in three r18x (falls back with a warning); PCFShadowMap + radius is the soft path
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
window.__nnInfo = () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });

const scene = new Scene();

const camera = new PerspectiveCamera(60, 1, 0.3, 2000);
function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const hud = new Hud(document.body);
const input = new Input();
const LOOK_HINT = 'Klicken zum Umsehen';
attachInput(input, canvas, (locked) => hud.setHint(locked ? '' : LOOK_HINT));
const world = new WorldLoader(scene, '/world/');

// courtyards, forecourts and gaps between buildings
const ground = new Mesh(new PlaneGeometry(6000, 6000), world.street.ground);
ground.rotation.x = -Math.PI / 2;
ground.renderOrder = -1;
ground.receiveShadow = true;
scene.add(ground);

/** Height of the first static surface below (x, fromY, z), or null. */
function surfaceY(pw: PhysicsWorld, x: number, z: number, fromY: number): number | null {
  const { rapier: R, world: w } = pw;
  const flags = R.QueryFilterFlags.EXCLUDE_DYNAMIC | R.QueryFilterFlags.EXCLUDE_KINEMATIC | R.QueryFilterFlags.EXCLUDE_SENSORS;
  const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), fromY + 5, true, flags);
  return hit ? fromY - hit.timeOfImpact : null;
}

/** The playable game: walking figure, cars, follow camera; built once world and physics are ready. */
class Game {
  mode: 'walk' | 'drive' = 'walk';
  flying = false;
  readonly char: Character;
  readonly figure = new PlayerFigure(scene);
  readonly cars: ParkedCars;
  readonly driven = new DrivenCar(scene);
  readonly follow: FollowCamera;
  readonly fly = new FreeFly(camera, input);
  private readonly stepper = new FixedStepper(DT, 5);
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

  constructor(readonly pw: PhysicsWorld, m: WorldManifest) {
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

  frame(dt: number): void {
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
        this.char.applyInput({ forward: steer.forward, right: steer.right, run: input.run() && !this.flying, yaw: this.follow.yaw, jump: this.jumpPending }, DT);
        this.jumpPending = false;
      } else {
        this.vehicle!.applyInput({ throttle: steer.forward, steer: steer.right, brake: input.brake() && !this.flying }, DT);
      }
      this.pw.step();
      this.prevPos = this.currPos;
      this.currPos = this.char.position();
      if (this.vehicle) {
        this.prevPose = this.currPose;
        this.currPose = this.vehicle.pose();
      }
    });
    this.cars.sync();
    this.proximityAge += dt;
    if (this.proximityAge > 0.5) {
      this.proximityAge = 0;
      const f = this.focus();
      this.cars.updateProximity(f.x, f.z);
    }
    this.render(dt);
  }

  private render(dt: number): void {
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
      this.driven.setLights(nightFactor, braking && !this.flying);
      if (!this.flying) this.follow.update(pose, headingOf(pose), dt);
    }
  }

  private toggleFly(): void {
    this.flying = !this.flying;
    input.clearPresses();
    if (this.flying) this.fly.setHeading(this.follow.yaw, this.follow.pitch);
    else this.follow.snap();
  }

  private getIn(): void {
    const id = nearestEnterableCar(this.currPos, this.cars.candidates());
    if (id === null) return;
    this.vehicle = this.cars.enter(id);
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
    const pose = this.vehicle!.pose();
    const heading = headingOf(pose);
    const spot = exitSpot({ x: pose.x, z: pose.z, heading }, (x, z) => this.exitFree(pose, x, z));
    if (!spot) {
      hud.flash('Hier kannst du nicht aussteigen');
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
    const flags = R.QueryFilterFlags.EXCLUDE_KINEMATIC | R.QueryFilterFlags.EXCLUDE_SENSORS;
    const dx = x - car.x, dz = z - car.z, d = Math.hypot(dx, dz);
    const y = car.y + 0.1;
    const reach = d + TUNING.character.radius;
    if (w.castRay(new R.Ray({ x: car.x, y, z: car.z }, { x: dx / d, y: 0, z: dz / d }), reach, true, flags, undefined, undefined, chassis)) return false;
    const T = TUNING.character;
    const capsule = new R.Capsule(T.height / 2 - T.radius, T.radius);
    // bottom 0.3 m above the road: clears kerbs, touches walls, posts and other cars
    const centre = { x, y: car.y - VEHICLE_REST_Y + 0.3 + T.height / 2, z };
    return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, flags, undefined, undefined, chassis) === null;
  }
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function slerpQ(qa: Quaternion, qb: Quaternion, a: CarPose, b: CarPose, t: number): { qx: number; qy: number; qz: number; qw: number } {
  qa.set(a.qx, a.qy, a.qz, a.qw).slerp(qb.set(b.qx, b.qy, b.qz, b.qw), t);
  return { qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w };
}

let game: Game | null = null;
let fps = 0;
if (debug) {
  const pad = (n: number): string => String(n).padStart(2, '0');
  new DebugOverlay(document.body, () => {
    const d = withDateParam(new Date(), dateOverride);
    const t = parseTimeOverride(timeOverride) ?? { h: d.getHours(), m: d.getMinutes() };
    // player view: the player's position (a ?cam link respawns the player there), camera yaw/pitch;
    // free-fly: the camera itself
    const flying = !game || game.flying;
    const p = flying ? camera.position : game!.focus();
    const yaw = flying ? (game ? game.fly.heading : 0) : game!.follow.yaw;
    const pitch = flying ? (game ? game.fly.pitch : 0) : game!.follow.pitch;
    return {
      x: p.x, y: p.y, z: p.z, yawDeg: yaw / DEG, pitchDeg: pitch / DEG,
      time: `${pad(t.h)}:${pad(t.m)}`, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    };
  }, () => ({
    ...localToWgs84(camera.position.x, camera.position.z), fps,
    drawCalls: renderer.info.render.calls, chunks: world.loadedKeys().size,
  }));
}

let lighting: Lighting | null = null;
let props: Props | null = null;
let propsRevision = -1;
let sun = currentSun();
let nightFactor = sun.nightFactor;
let sunAge = 0;
const timer = new Timer();
renderer.setAnimationLoop((t: number) => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (dt > 0) fps += (1 / dt - fps) * 0.1;
  if (game && lighting && props) {
    game.frame(dt);
    world.update(camera.position);
    if (world.revision !== propsRevision) {
      propsRevision = world.revision;
      props.rebuild(world.loadedKeys());
    }
    sunAge += dt;
    if (sunAge >= 1) {
      sunAge = 0;
      sun = currentSun();
    }
    nightFactor = sun.nightFactor;
    lighting.update(sun, camera.position);
    props.setNight(nightFactor);
  }
  renderer.render(scene, camera);
});

/** collision.bin → physics world (runs while the spawn chunks stream in). */
async function loadPhysics(): Promise<PhysicsWorld> {
  const url = '/world/collision.bin';
  const res = await fetch(url);
  if (!res.ok) throw new FetchError(url, res.status);
  return createPhysicsWorld(decodeCollision(await res.arrayBuffer()));
}

const start = devCam ? { x: devCam.x, z: devCam.z } : undefined;
Promise.all([world.init((p) => hud.setProgress(p), start), loadPhysics()]).then(([m, pw]) => {
  hud.setAttribution(m.attribution);
  props = new Props(scene, m);
  lighting = new Lighting(scene, m.lamps, props.lampGlass, props.halo, world.facade.userData.nightFactor, world.facade.userData.sky);
  game = new Game(pw, m);
  if (devCam && debug && devCam.y > 20) {
    // an aerial debug link: open in free-fly at that camera instead of dropping the player onto a roof
    camera.position.set(devCam.x, devCam.y, devCam.z);
    game.fly.setHeading(devCam.yawDeg * DEG, devCam.pitchDeg * DEG);
    game.flying = true;
  }
  window.__nnState = () => {
    const f = game!.focus();
    return { mode: game!.mode, flying: game!.flying, x: f.x, y: f.y, z: f.z, speed: game!.speed() };
  };
  window.__nnSurfaceY = (x, z) => surfaceY(pw, x, z, 100);
  hud.hideLoading();
  hud.setHint(LOOK_HINT);
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
  hud.showError('Nippes konnte nicht geladen werden. Bitte lade die Seite neu.');
  window.__nnReady = 'error';
});
