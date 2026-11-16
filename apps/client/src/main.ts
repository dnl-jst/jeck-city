import {
  ACESFilmicToneMapping, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene, Timer, WebGLRenderer,
} from 'three';
import {
  createPhysicsWorld, decodeCollision, decodeTerrain, heightAt, localToWgs84, parseMapData, parseTimeOverride, sunState,
  type MapData, type PhysicsWorld, type SunState, type TerrainGrid,
} from '@nn/shared';
import { NoWebGLError } from './errors';
import { bootErrorMessage, Hud } from './hud';
import { fetchOk, WorldLoader } from './loader';
import { parseCamParam, withDateParam } from './devparams';
import { Lighting } from './lighting';
import { Props } from './props';
import { CAMERA_FOV } from './camera';
import { DebugOverlay } from './debug';
import { attachInput, Input } from './input';
import { Game, surfaceY } from './game';
import { AudioMixer } from './audio/mixer';
import { Radio } from './audio/radio';
import { RadioTuner, type StationId } from './audio/stations';
import { GameAudio } from './audio/game-audio';
import { RadioWheel } from './radio-wheel';
import { MapGrid } from './map/grid';
import { StreetTracker } from './map/street';
import { Minimap } from './map/minimap';
import { BigMap } from './map/big-map';

declare global {
  interface Window {
    __nnReady?: boolean | 'error';
    /** Dev: the renderer's per-frame statistics (draw calls, triangles). */
    __nnInfo?: () => { calls: number; triangles: number };
    /**
     * Dev/tests: what the player is doing (radio: the chosen station, null on foot), physics steps so far, and the
     * height of the first static surface below 100 m above the terrain at (x, z).
     */
    __nnState?: () => {
      mode: 'walk' | 'drive' | 'ride'; bikeType: string | null; flying: boolean; x: number; y: number; z: number; speed: number; steps: number; radio: StationId | null;
      engine: 'off' | 'starting' | 'running'; mapOpen: boolean; wheelOpen: boolean; wheelHighlighted: StationId | null;
    };
    __nnSurfaceY?: (x: number, z: number) => number | null;
    /** Dev build only: mouse movement (px) as if under pointer lock, e.g. to point the radio wheel headless. */
    __nnWheelNudge?: (dx: number, dy: number) => void;
  }
  interface ImportMeta { readonly env: { readonly DEV: boolean } }
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

const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.3, 2000);
function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const input = new Input();
const LOOK_HINT = 'Klicken zum Umsehen';
attachInput(input, canvas, (locked) => {
  hud.setHint(locked ? '' : LOOK_HINT);
  game?.map.onLockChange(locked);
});
const world = new WorldLoader(scene, '/world/');

// sound: nothing plays before the first user gesture; the recordings load in parallel with the world
const mixer = new AudioMixer();
const radio = new Radio(() => new Audio(), {
  onConnecting: () => gameAudio.radioEvents.onConnecting(),
  onPlaying: () => gameAudio.radioEvents.onPlaying(),
  onUnreachable: () => gameAudio.radioEvents.onUnreachable(),
});
const gameAudio = new GameAudio({ mixer, radio, tuner: new RadioTuner(), flash: (t) => hud.flash(t) });
const radioWheel = new RadioWheel(document.body);
gameAudio.load().catch(console.error);
// no `once`: a later rejected play()/resume() is retried on the next gesture (unlock is idempotent)
window.addEventListener('pointerdown', () => gameAudio.unlock());
window.addEventListener('keydown', () => gameAudio.unlock());
document.addEventListener('visibilitychange', () => gameAudio.setHidden(document.hidden));

// far ground beyond the terrain grid (the chunks' `ground` meshes cover the world area); y from the manifest
const farGround = new Mesh(new PlaneGeometry(6000, 6000), world.street.ground);
farGround.rotation.x = -Math.PI / 2;
farGround.renderOrder = -1;
farGround.receiveShadow = true;
farGround.visible = false; // until the manifest says how low it lies
scene.add(farGround);

let game: Game | null = null;
/** Minimap and big map; stay null when map.json fails to load (the game runs without a map). */
let maps: { minimap: Minimap; bigMap: BigMap; tracker: StreetTracker } | null = null;
let bigMapOpen = false;
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
    for (const i of game.props.takeFallen()) {
      props.knockDown(i);
      lighting.lampOut(i);
    }
    props.syncFallen((i) => game!.props.lampPose(i));
    radioWheel.render({ ...game.wheelState, current: gameAudio.station });
    if (maps) {
      const flying = game.flying;
      const p = flying ? camera.position : game.focus();
      const yaw = flying ? game.fly.heading : game.follow.yaw;
      const open = game.map.open;
      if (open !== bigMapOpen) {
        bigMapOpen = open;
        if (open) maps.bigMap.open(p.x, p.z);
        else maps.bigMap.close();
        maps.minimap.setVisible(!open);
      }
      maps.minimap.update(p.x, p.z, yaw, maps.tracker.update(p.x, p.z));
      if (open) maps.bigMap.update(game.mapInput, { x: p.x, z: p.z, yaw });
    }
    world.update(camera.position);
    if (world.revision !== propsRevision) {
      propsRevision = world.revision;
      props.rebuild(world.loadedKeys());
    }
    props.updateTrees(camera.position.x, camera.position.z);
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

/** collision.bin + terrain.bin → physics world (runs while the spawn chunks stream in). */
let physicsLoading = true;
let worldStatus = '';
const showStatus = (): void => hud.setStatus(physicsLoading ? `${worldStatus} · Physik …` : worldStatus);
async function loadPhysics(): Promise<{ pw: PhysicsWorld; terrain: TerrainGrid }> {
  const [collision, terrain] = await Promise.all([
    fetchOk('/world/collision.bin').then(async (r) => decodeCollision(await r.arrayBuffer())),
    fetchOk('/world/terrain.bin').then(async (r) => decodeTerrain(await r.arrayBuffer())),
  ]);
  const pw = await createPhysicsWorld(collision, terrain);
  physicsLoading = false; // only once the world is built
  showStatus();
  return { pw, terrain };
}

/** map.json → minimap and big map; a failure only means no map. */
async function loadMap(): Promise<MapData | null> {
  try {
    const res = await fetchOk('/world/map.json');
    return parseMapData(await res.json());
  } catch (err) {
    console.error(err);
    return null;
  }
}

const start = devCam ? { x: devCam.x, z: devCam.z } : undefined;
Promise.all([world.init((p) => hud.setProgress(p), start, (s) => { worldStatus = s; showStatus(); }), loadPhysics(), loadMap()]).then(async ([m, { pw, terrain }, mapData]) => {
  // bikes still ride without their models (unseen), so a failed model download is not fatal
  const bikeModels = await world.loadBikeModels(m).catch((err: unknown) => {
    console.error(err);
    return undefined;
  });
  const carModels = await world.loadCarModels(m).catch((err: unknown) => {
    console.error(err);
    return undefined;
  });
  hud.setAttribution(m.attribution);
  farGround.position.y = m.farGroundY;
  farGround.visible = true;
  props = new Props(scene, m, terrain);
  lighting = new Lighting(
    scene, m.lamps, props.lampGlass, props.halo, world.facade.userData.nightFactor, world.facade.userData.sky,
    (x, z) => heightAt(terrain, x, z),
  );
  game = new Game(pw, m, { scene, camera, input, hud, debug, devCam, terrain, audio: gameAudio, bikeModels, carModels });
  if (devCam && debug && devCam.y - heightAt(terrain, devCam.x, devCam.z) > 20) {
    // an aerial debug link: open in free-fly at that camera instead of dropping the player onto a roof
    camera.position.set(devCam.x, devCam.y, devCam.z);
    game.fly.setHeading(devCam.yawDeg * DEG, devCam.pitchDeg * DEG);
    game.flying = true;
  }
  if (mapData) {
    try {
      const grid = new MapGrid(mapData);
      maps = { minimap: new Minimap(document.body, mapData, grid), bigMap: new BigMap(document.body, mapData, grid), tracker: new StreetTracker(mapData, grid) };
      game.map.enabled = true;
    } catch (err) {
      console.error(err);
    }
  }
  if (params.get('map') === 'open') game.map.toggle();
  window.__nnState = () => {
    const f = game!.focus();
    return {
      mode: game!.mode, bikeType: game!.bikeType(), flying: game!.flying, x: f.x, y: f.y, z: f.z, speed: game!.speed(), steps: game!.steps,
      radio: gameAudio.station,
      engine: game!.ignition.state, mapOpen: game!.map.open, wheelOpen: game!.wheelState.open, wheelHighlighted: game!.wheelState.highlighted,
    };
  };
  if (import.meta.env.DEV) window.__nnWheelNudge = (dx, dy) => input.mouseMove(dx, dy);
  window.__nnSurfaceY = (x, z) => surfaceY(pw, x, z, heightAt(terrain, x, z) + 100);
  hud.hideLoading();
  hud.setHint(LOOK_HINT);
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
  hud.showError(bootErrorMessage(err));
  window.__nnReady = 'error';
});
