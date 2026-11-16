import {
  ACESFilmicToneMapping, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene, Timer, WebGLRenderer,
} from 'three';
import {
  CHARACTER_VARIANTS, decodeCollision, decodeTerrain, heightAt, localToWgs84, parseManifest, parseMapData, parseTimeOverride, sunState, surfaceY, worldHash, WorldSim,
  type MapData, type SunState, type TerrainGrid, type WorldManifest,
} from '@nn/shared';
import { NoWebGLError } from './errors';
import { bootErrorMessage, Hud } from './hud';
import { fetchOk, WorldLoader } from './loader';
import { parseCamParam, withDateParam } from './devparams';
import { Lighting } from './lighting';
import { Props } from './props';
import { loadTreeVariants } from './trees';
import { CAMERA_FOV } from './camera';
import { DebugOverlay } from './debug';
import { attachInput, Input } from './input';
import { Game } from './game';
import { storedCharacter } from './characters';
import { OfflineSession, type Session } from './session';
import { OnlineSession } from './net/online-session';
import { Lobby } from './net/lobby';
import { Connection, connectRoom, JoinRejected, STATUS_TEXTS } from './net/connection';
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
      /** Online: how far (m) server corrections moved the rendered own pose in the last frame (0 offline). */
      correction: number;
    };
    __nnSurfaceY?: (x: number, z: number) => number | null;
    /** Dev/debug: the server connection (null offline). */
    __nnConn?: () => Connection | null;
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
// ?offline=1: a local WorldSim without a server and without the name dialog; only with the dev server or ?debug=1,
// otherwise ignored (everyone else plays online)
const offline = params.get('offline') === '1' && (import.meta.env.DEV || debug);
/** The local player's id in an offline session. */
const OFFLINE_ME = 0;
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
    for (const i of game.takeFallenLamps()) {
      props.knockDown(i);
      lighting.lampOut(i);
    }
    // lamps the server (or its reset) stood up again, or a predicted knock it never confirmed
    for (const i of props.fallenLamps()) {
      if (!game.session.sim.props.isStanding(i)) continue;
      props.standUp(i);
      lighting.lampOn(i);
    }
    props.syncFallen((i) => game!.session.sim.props.lampPose(i));
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

/** The raw bytes of manifest.json: parsed for the chunk loader and the simulation, hashed for the join. */
const manifestBytes: Promise<ArrayBuffer> = fetchOk('/world/manifest.json').then((r) => r.arrayBuffer());
const manifestLoad: Promise<WorldManifest> = manifestBytes.then((b) => parseManifest(JSON.parse(new TextDecoder().decode(b))));
/** manifest + collision.bin + terrain.bin → the simulated world (built while the spawn chunks stream in). */
let physicsLoading = true;
let worldStatus = '';
const showStatus = (): void => hud.setStatus(physicsLoading ? `${worldStatus} · Physik …` : worldStatus);
async function loadSim(): Promise<{ sim: WorldSim; terrain: TerrainGrid }> {
  const [manifest, collision, terrain] = await Promise.all([
    manifestLoad,
    fetchOk('/world/collision.bin').then(async (r) => decodeCollision(await r.arrayBuffer())),
    fetchOk('/world/terrain.bin').then(async (r) => decodeTerrain(await r.arrayBuffer())),
  ]);
  const sim = await WorldSim.create({ manifest, collision, terrain });
  physicsLoading = false; // only once the world is built
  showStatus();
  return { sim, terrain };
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

/** The server connection (online mode, once joined); the game then plays on an OnlineSession. */
let connection: Connection | null = null;
/**
 * Name dialog → join. Resolves with the connection (null offline). The world keeps loading meanwhile; a version
 * conflict leaves the dialog showing its text and never resolves.
 */
async function connect(): Promise<Connection | null> {
  if (offline) return null;
  const lobby = new Lobby(document.body);
  const hash = await worldHash(await manifestBytes);
  for (;;) {
    const name = await lobby.ask();
    try {
      const conn = await connectRoom(name, hash, lobby, CHARACTER_VARIANTS.indexOf(storedCharacter()));
      conn.onStatus((s) => hud.setNetStatus(s === 'reconnecting' ? STATUS_TEXTS.reconnecting : s === 'lost' ? 'Verbindung verloren – bitte Seite neu laden.' : ''));
      lobby.close();
      return conn;
    } catch (e) {
      if (!(e instanceof JoinRejected)) throw e;
      if (e.failure.kind === 'version') return new Promise<never>(() => undefined);
      // bad name: its text is shown under the field, ask again
    }
  }
}

const start = devCam ? { x: devCam.x, z: devCam.z } : undefined;
Promise.all([world.init((p) => hud.setProgress(p), start, (s) => { worldStatus = s; showStatus(); }, manifestLoad), loadSim(), loadMap(), connect()]).then(async ([m, { sim, terrain }, mapData, conn]) => {
  connection = conn;
  // bikes still ride without their models (unseen), so a failed model download is not fatal
  const characters = world.characterModels(m);
  const [bikeModels, character] = await Promise.all([
    world.loadBikeModels(m).catch((err: unknown) => {
      console.error(err);
      return undefined;
    }),
    // only the shown figure now (the other loads when switched to); without it the player is the primitive stand-in
    characters.variants.length ? characters.load(storedCharacter()).catch((err: unknown) => {
      console.error(err);
      return null;
    }) : null,
  ]);
  const carModels = await world.loadCarModels(m).catch((err: unknown) => {
    console.error(err);
    return undefined;
  });
  hud.setAttribution(m.attribution);
  farGround.position.y = m.farGroundY;
  farGround.visible = true;
  props = new Props(scene, m, terrain, await loadTreeVariants());
  lighting = new Lighting(
    scene, m.lamps, props.lampGlass, props.halo, world.facade.userData.nightFactor, world.facade.userData.sky,
    (x, z) => heightAt(terrain, x, z),
  );
  // online, the local figure starts where the server most likely spawned it; the first snapshot sets it exactly
  let session: Session;
  if (conn) {
    sim.addPlayer(conn.welcome.slot, start);
    if (start && conn.welcome.devMode) conn.sendTeleport(start.x, start.z);
    session = new OnlineSession(sim, conn);
  } else {
    sim.addPlayer(OFFLINE_ME, start);
    session = new OfflineSession(sim, OFFLINE_ME);
  }
  game = new Game(session, m, { scene, camera, input, hud, debug, devCam, audio: gameAudio, bikeModels, carModels, characters, character });
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
      engine: game!.engine, mapOpen: game!.map.open, wheelOpen: game!.wheelState.open, wheelHighlighted: game!.wheelState.highlighted,
      correction: session instanceof OnlineSession ? session.correction : 0,
    };
  };
  if (import.meta.env.DEV) window.__nnWheelNudge = (dx, dy) => input.mouseMove(dx, dy);
  if (import.meta.env.DEV || debug) window.__nnConn = () => connection;
  window.__nnSurfaceY = (x, z) => surfaceY(sim.pw, x, z, heightAt(terrain, x, z) + 100);
  hud.hideLoading();
  hud.setHint(LOOK_HINT);
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
  hud.showError(bootErrorMessage(err));
  window.__nnReady = 'error';
});
