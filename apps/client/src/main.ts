import {
  ACESFilmicToneMapping, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene, Timer, WebGLRenderer,
} from 'three';
import {
  createPhysicsWorld, decodeCollision, localToWgs84, parseTimeOverride, sunState, type PhysicsWorld, type SunState,
} from '@nn/shared';
import { NoWebGLError } from './errors';
import { bootErrorMessage, Hud } from './hud';
import { fetchOk, WorldLoader } from './loader';
import { parseCamParam, withDateParam } from './devparams';
import { Lighting } from './lighting';
import { Props } from './props';
import { DebugOverlay } from './debug';
import { attachInput, Input } from './input';
import { Game, surfaceY } from './game';

declare global {
  interface Window {
    __nnReady?: boolean | 'error';
    /** Dev: the renderer's per-frame statistics (draw calls, triangles). */
    __nnInfo?: () => { calls: number; triangles: number };
    /** Dev/tests: what the player is doing, physics steps so far, and the height of the first static surface below (x, 100, z). */
    __nnState?: () => { mode: 'walk' | 'drive'; flying: boolean; x: number; y: number; z: number; speed: number; steps: number };
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

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = new Hud(document.body);
/** Shows the boot error on the loading screen and stops the boot. */
function bootFailed(err: unknown): never {
  console.error(err);
  hud.showError(bootErrorMessage(err));
  window.__nnReady = 'error';
  throw err;
}
// WebGL2 is checked before anything else is set up
if (!document.createElement('canvas').getContext('webgl2')) bootFailed(new NoWebGLError());
let renderer: WebGLRenderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, reversedDepthBuffer: true });
} catch (err) {
  bootFailed(new NoWebGLError(String(err)));
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
    game.frame(dt, nightFactor);
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
let physicsLoading = true;
let worldStatus = '';
const showStatus = (): void => hud.setStatus(physicsLoading ? `${worldStatus} · Physik …` : worldStatus);
async function loadPhysics(): Promise<PhysicsWorld> {
  const url = '/world/collision.bin';
  const res = await fetchOk(url);
  const pw = await createPhysicsWorld(decodeCollision(await res.arrayBuffer()));
  physicsLoading = false; // only once the world is built
  showStatus();
  return pw;
}

const start = devCam ? { x: devCam.x, z: devCam.z } : undefined;
Promise.all([world.init((p) => hud.setProgress(p), start, (s) => { worldStatus = s; showStatus(); }), loadPhysics()]).then(([m, pw]) => {
  hud.setAttribution(m.attribution);
  props = new Props(scene, m);
  lighting = new Lighting(scene, m.lamps, props.lampGlass, props.halo, world.facade.userData.nightFactor, world.facade.userData.sky);
  game = new Game(pw, m, { scene, camera, input, hud, debug, devCam });
  if (devCam && debug && devCam.y > 20) {
    // an aerial debug link: open in free-fly at that camera instead of dropping the player onto a roof
    camera.position.set(devCam.x, devCam.y, devCam.z);
    game.fly.setHeading(devCam.yawDeg * DEG, devCam.pitchDeg * DEG);
    game.flying = true;
  }
  window.__nnState = () => {
    const f = game!.focus();
    return { mode: game!.mode, flying: game!.flying, x: f.x, y: f.y, z: f.z, speed: game!.speed(), steps: game!.steps };
  };
  window.__nnSurfaceY = (x, z) => surfaceY(pw, x, z, 100);
  hud.hideLoading();
  hud.setHint(LOOK_HINT);
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
  hud.showError(bootErrorMessage(err));
  window.__nnReady = 'error';
});
