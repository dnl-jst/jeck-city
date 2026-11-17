import {
  ACESFilmicToneMapping, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene, Timer, WebGLRenderer,
} from 'three';
import {
  CHARACTER_VARIANTS, decodeCollision, decodeTerrain, heightAt, localToWgs84, parseManifest, parseMapData, parseTimeOverride, sunState, surfaceY, UNKNOWN_WEATHER, weatherPreset, worldHash, WorldSim,
  type MapData, type SunState, type TerrainGrid, type Weather, type WorldManifest,
} from '@nn/shared';
import { NoWebGLError } from './errors';
import { bootErrorMessage, Hud } from './hud';
import { nextQuality, QUALITY, QUALITY_LABEL, storedQuality, storeQuality, type QualityLevel } from './quality';
import { DownloadMeter, downloadSummary, trackFetch } from './downloads';
import { fetchOk, WorldLoader } from './loader';
import { devAllowed, parseCamParam, withDateParam } from './devparams';
import { Lighting } from './lighting';
import { CLEAR_LOOK, WeatherBlend } from './weather/look';
import { Props } from './props';
import { loadTreeVariants } from './trees';
import { CAMERA_FOV } from './camera';
import { DebugOverlay } from './debug';
import { attachInput, Input } from './input';
import { Game } from './game';
import { storeCharacter, storedCharacter } from './characters';
import { OfflineSession, type Session } from './session';
import { OnlineSession, remoteList, type RemotePlayerInfo } from './net/online-session';
import { Lobby } from './net/lobby';
import { Connection, connectRoom, JoinRejected, STATUS_TEXTS } from './net/connection';
import { AudioMixer } from './audio/mixer';
import { Radio } from './audio/radio';
import { RadioTuner, type StationId } from './audio/stations';
import { GameAudio } from './audio/game-audio';
import { RemoteAudio } from './audio/remote-audio';
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
      mode: 'walk' | 'drive' | 'ride'; bikeType: string | null; flying: boolean; /** Fell off a bike: lying or getting up. */ fallen: boolean; x: number; y: number; z: number; speed: number; steps: number; radio: StationId | null;
      engine: 'off' | 'starting' | 'running'; mapOpen: boolean; wheelOpen: boolean; wheelHighlighted: StationId | null;
      /** Online: how far (m) server corrections moved the rendered own pose in the last frame (0 offline). */
      correction: number;
      /** Playing on a server. */
      online: boolean;
      /** Players in the room (1 offline). */
      players: number;
      /** Online: reconciliations so far (replayed, skipped because the prediction matched, set hard); null offline. */
      reconciles: { replayed: number; skipped: number; hard: number } | null;
    };
    __nnSurfaceY?: (x: number, z: number) => number | null;
    /** Dev/debug: the server connection (null offline). */
    __nnConn?: () => Connection | null;
    /** Online (read-only): the other players as sampled for the current frame; mode 'down' = knocked over. */
    __nnRemote?: () => RemotePlayerInfo[];
    /** Online (read-only): remote car sound voices (engines, horns, the remote radio's station, engine fade levels by car). */
    __nnRemoteAudio?: () => { engines: number; horns: number; radio: StationId | null; levels: [number, number][] };
    /** Dev build only (and, online, only with a dev-mode server): mouse movement (px) as if under pointer lock, e.g. to point the radio wheel headless. */
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
const devCamParam = parseCamParam(params.get('cam'));
// ?offline=1: a local WorldSim without a server and without the name dialog; only with the dev server or ?debug=1,
// otherwise ignored (everyone else plays online)
const offline = params.get('offline') === '1' && (import.meta.env.DEV || debug);
/** The local player's id in an offline session. */
const OFFLINE_ME = 0;
const DEG = Math.PI / 180;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = new Hud(document.body);
// every download while the game boots is counted; if loading takes a while the loading screen shows the details
const downloads = new DownloadMeter();
const untrackFetch = trackFetch(downloads);
/** The detailed download panel appears once booting has taken this long and bytes are still on their way. */
const DOWNLOAD_DETAILS_AFTER_MS = 1500;
const bootStart = performance.now();
let downloadDetails = false;
/** The name dialog while it is up (it covers the loading screen, so it shows the download line too). */
let lobby: Lobby | null = null;
const downloadTimer = window.setInterval(() => {
  const now = performance.now();
  const s = downloads.snapshot(now);
  if (!downloadDetails && now - bootStart >= DOWNLOAD_DETAILS_AFTER_MS && s.active > 0) downloadDetails = true;
  if (!downloadDetails) return;
  hud.setDownloads(s);
  lobby?.setDownload(s.total > 0 ? s.received / s.total : 0, downloadSummary(s));
}, 250);
/** Loading screen gone (or failed): stop counting. */
function stopDownloadMeter(): void {
  window.clearInterval(downloadTimer);
  untrackFetch();
}
/** Shows the boot error on the loading screen and stops the boot. */
function bootFailed(err: unknown): never {
  console.error(err);
  stopDownloadMeter();
  hud.showError(bootErrorMessage(err));
  window.__nnReady = 'error';
  throw err;
}
// WebGL2 is checked before anything else is set up
if (!document.createElement('canvas').getContext('webgl2')) bootFailed(new NoWebGLError());
/** Graphics quality (G cycles it; ?quality=low|medium|high overrides the stored choice). */
let qualityLevel: QualityLevel = storedQuality(params.get('quality'));
/** Antialiasing is fixed with the WebGL context: a level switch changes it only on the next page load. */
const bootAntialias = QUALITY[qualityLevel].antialias;
let renderer: WebGLRenderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: bootAntialias, reversedDepthBuffer: true });
} catch (err) {
  bootFailed(new NoWebGLError(String(err)));
}
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// PCFSoftShadowMap was removed in three r18x (falls back with a warning); PCFShadowMap + radius is the soft path
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
window.__nnInfo = () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, quality: qualityLevel });

const scene = new Scene();

const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.3, 2000);
function resize(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[qualityLevel].pixelRatio));
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
// the other players' cars: a second stream element per remote radio, routed through Web Audio (the own radio stays plain)
const remoteAudio = new RemoteAudio(mixer, () => new Audio());
const gameAudio = new GameAudio({ mixer, radio, tuner: new RadioTuner(), flash: (t) => hud.flash(t), remote: remoteAudio });
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
/** The game's session once online (the debug overlay's net lines). */
let onlineSession: OnlineSession | null = null;
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
    net: onlineSession?.stats() ?? null,
  }));
}

let lighting: Lighting | null = null;
/** Applies the current quality level to the renderer, lights, shadows, view distance, chunks, trees and cars (all live but MSAA). */
function applyQuality(): void {
  const q = QUALITY[qualityLevel];
  resize();
  lighting?.setQuality(q);
  props?.setTreeRadii(q.treeRadius, q.treeShadowRadius);
  world.setRadii(q.loadRadius, q.unloadRadius);
  game?.setQuality(q);
}
let props: Props | null = null;
let propsRevision = -1;
let sun = currentSun();
let nightFactor = sun.nightFactor;
let sunAge = 0;
/** Dev override from `?weather=` (set once the dev permissions are known). */
let weatherOverride: Weather | null = null;
const weatherBlend = new WeatherBlend();
/** The blended weather of this frame; Tasks 5-8 pass it on to lighting, particles, audio and HUD. */
let look = CLEAR_LOOK;
const timer = new Timer();
/** Frame cap: high-refresh displays (120/144 Hz) render at most 60 fps. */
const FRAME_MS = 1000 / 60;
let lastFrame = -Infinity;
renderer.setAnimationLoop((t: number) => {
  const elapsed = t - lastFrame;
  if (elapsed < FRAME_MS - 1) return; // 1 ms slack so a 60 Hz vsync never skips a frame
  // Advance on a fixed 60 Hz grid so 144 Hz averages 60 fps instead of 48;
  // the clamp drops the backlog after a stall instead of bursting to catch up.
  lastFrame = Math.max(lastFrame + FRAME_MS, t - FRAME_MS);
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (dt > 0) fps += (1 / dt - fps) * 0.1;
  if (game && lighting && props) {
    if (input.consume('KeyG')) {
      qualityLevel = nextQuality(qualityLevel);
      storeQuality(qualityLevel);
      applyQuality();
      const aa = QUALITY[qualityLevel].antialias === bootAntialias ? '' : ' (Kantenglättung ab dem nächsten Laden)';
      hud.flash(`Grafik: ${QUALITY_LABEL[qualityLevel]}${aa}`);
    }
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
    const wx = weatherOverride ?? game.session.weather?.() ?? UNKNOWN_WEATHER;
    weatherBlend.offer(wx);
    look = weatherBlend.update(dt);
    lighting.update(sun, camera.position);
    // the far plane at the fog's end: what the fog hides completely is culled, not drawn
    const far = lighting.viewFar + 5;
    if (Math.abs(camera.far - far) > 0.5) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    props.setNight(nightFactor);
  }
  renderer.render(scene, camera);
});

/**
 * The raw bytes of manifest.json: parsed for the chunk loader and the simulation, hashed for the join. It and the
 * simulation's world files are always revalidated: a stale copy after a deploy would not match the server's world.
 */
const manifestBytes: Promise<ArrayBuffer> = fetchOk('/world/manifest.json', { cache: 'no-cache' }).then((r) => r.arrayBuffer());
const manifestLoad: Promise<WorldManifest> = manifestBytes.then((b) => parseManifest(JSON.parse(new TextDecoder().decode(b))));
/** manifest + collision.bin + terrain.bin → the simulated world (built while the spawn chunks stream in). */
let physicsLoading = true;
let worldStatus = '';
const showStatus = (): void => hud.setStatus(physicsLoading ? `${worldStatus} · Physik …` : worldStatus);
async function loadSim(): Promise<{ sim: WorldSim; terrain: TerrainGrid }> {
  // the manifest first: it gates the name dialog's join and the spawn chunks, so it gets the bandwidth to itself
  const manifest = await manifestLoad;
  const [collision, terrain] = await Promise.all([
    fetchOk('/world/collision.bin', { cache: 'no-cache' }).then(async (r) => decodeCollision(await r.arrayBuffer())),
    fetchOk('/world/terrain.bin', { cache: 'no-cache' }).then(async (r) => decodeTerrain(await r.arrayBuffer())),
  ]);
  // in slices: the page (name field, loading screen) stays responsive while the city's colliders are built
  const sim = await WorldSim.create({ manifest, collision, terrain }, { sliceMs: 12 });
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
  const dialog = lobby = new Lobby(document.body, CHARACTER_VARIANTS.map((v) => `/portraits/${v}.webp`), CHARACTER_VARIANTS.indexOf(storedCharacter()));
  // the dialog shows at once; the world hash (needs the whole manifest) is only awaited on joining
  const hashing = manifestBytes.then((b) => worldHash(b));
  hashing.catch(() => undefined); // a failed manifest download fails the boot elsewhere
  for (;;) {
    const name = await dialog.ask();
    storeCharacter(CHARACTER_VARIANTS[dialog.variant] ?? CHARACTER_VARIANTS[0]);
    dialog.showStatus(STATUS_TEXTS.connecting);
    const hash = await hashing;
    try {
      const conn = await connectRoom(name, hash, dialog, CHARACTER_VARIANTS.indexOf(storedCharacter()));
      conn.onStatus((s) => hud.setNetStatus(s === 'reconnecting' ? STATUS_TEXTS.reconnecting : s === 'lost' ? 'Verbindung verloren – bitte Seite neu laden.' : ''));
      dialog.close();
      lobby = null;
      return conn;
    } catch (e) {
      if (!(e instanceof JoinRejected)) throw e;
      if (e.failure.kind === 'version') return new Promise<never>(() => undefined);
      // bad name: its text is shown under the field, ask again
    }
  }
}

const start = devCamParam ? { x: devCamParam.x, z: devCamParam.z } : undefined;
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
  const allowed = devAllowed(conn ? 'online' : 'offline', conn?.welcome ?? null, debug, import.meta.env.DEV);
  const devCam = allowed.cam ? devCamParam : null;
  if (allowed.weather) weatherOverride = weatherPreset(params.get('weather'), Date.now());
  let session: Session;
  if (conn) {
    // online, ?cam / fly / write hooks need a dev-mode server (?cam then teleports once)
    sim.addPlayer(conn.welcome.slot, devCam ? start : undefined);
    if (devCam) conn.sendTeleport(devCam.x, devCam.z);
    session = onlineSession = new OnlineSession(sim, conn);
  } else {
    sim.addPlayer(OFFLINE_ME, start);
    session = new OfflineSession(sim, OFFLINE_ME);
  }
  game = new Game(session, m, { scene, camera, input, hud, flyAllowed: allowed.fly, devCam, audio: gameAudio, bikeModels, carModels, characters, character });
  applyQuality(); // before the first frame with the world's lights: materials compile once, for this level
  if (devCam && allowed.fly && devCam.y - heightAt(terrain, devCam.x, devCam.z) > 20) {
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
      mode: game!.mode, bikeType: game!.bikeType(), flying: game!.flying, fallen: game!.figure.busy, x: f.x, y: f.y, z: f.z, speed: game!.speed(), steps: game!.steps,
      radio: gameAudio.station,
      engine: game!.engine, mapOpen: game!.map.open, wheelOpen: game!.wheelState.open, wheelHighlighted: game!.wheelState.highlighted,
      correction: session instanceof OnlineSession ? session.correction : 0,
      online: !!conn, players: onlineSession?.stats().players ?? 1,
      reconciles: onlineSession ? { ...onlineSession.reconciles } : null,
    };
  };
  // write hooks (they change state) only where dev tools are allowed; the read-only getters always exist
  if (import.meta.env.DEV && allowed.writeHooks) window.__nnWheelNudge = (dx, dy) => input.mouseMove(dx, dy);
  if (allowed.writeHooks) window.__nnConn = () => connection;
  window.__nnRemote = () => {
    if (!onlineSession) return [];
    const roster = onlineSession.roster();
    return remoteList(onlineSession.remote(), roster.names, roster.cars, onlineSession.me);
  };
  window.__nnRemoteAudio = () => ({ ...remoteAudio.stats, levels: [...remoteAudio.engineLevels()] });
  window.__nnSurfaceY = (x, z) => surfaceY(sim.pw, x, z, heightAt(terrain, x, z) + 100);
  stopDownloadMeter();
  hud.hideLoading();
  hud.setHint(LOOK_HINT);
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
  stopDownloadMeter();
  hud.showError(bootErrorMessage(err));
  window.__nnReady = 'error';
});
