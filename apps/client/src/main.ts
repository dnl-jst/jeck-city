import {
  ACESFilmicToneMapping, Euler, Mesh, PCFShadowMap, PerspectiveCamera, PlaneGeometry, Scene, Timer, Vector3, WebGLRenderer,
} from 'three';
import { localToWgs84, parseTimeOverride, sunState, type SunState } from '@nn/shared';
import { NoWebGLError } from './errors';
import { Hud } from './hud';
import { WorldLoader } from './loader';
import { parseCamParam, withDateParam } from './devparams';
import { Lighting } from './lighting';
import { Props } from './props';
import { DebugOverlay } from './debug';

declare global {
  interface Window {
    __nnReady?: boolean | 'error';
    /** Dev: the renderer's per-frame statistics (draw calls, triangles). */
    __nnInfo?: () => { calls: number; triangles: number };
  }
}

const params = new URLSearchParams(location.search);
// dev hooks: ?time=HH:MM overrides the wall-clock time, ?date=YYYY-MM-DD the date (sun position)
const timeOverride = params.get('time') ?? undefined;
const dateOverride = params.get('date');
const currentSun = (): SunState => sunState(withDateParam(new Date(), dateOverride), timeOverride);
// dev hook: ?cam=x,y,z,yawDeg,pitchDeg places the fly camera (yaw: manifest heading convention)
const devCam = parseCamParam(params.get('cam'));

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

/** Provisional free-fly camera (Task 11 replaces it): WASD, drag to look, Q/E down/up, Shift fast. */
class FreeFly {
  yaw = 0;
  pitch = 0;
  private readonly keys = new Set<string>();
  private dragging = false;

  constructor(private readonly cam: PerspectiveCamera, el: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => { this.dragging = true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { this.dragging = false; });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= e.movementX * 0.004;
      this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch - e.movementY * 0.004));
    });
  }

  /** Points the camera along a manifest heading h (forward = (sin h, cos h) in x/z). */
  setHeading(h: number, pitch = 0): void {
    // camera looks along -Z at yaw 0; rotating by yaw gives forward (-sin yaw, -cos yaw)
    this.yaw = h + Math.PI;
    this.pitch = pitch;
  }

  update(dt: number): void {
    this.cam.quaternion.setFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 40 : 6) * dt;
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(this.cam.quaternion);
    this.cam.position
      .addScaledVector(fwd, (k('KeyW') - k('KeyS')) * speed)
      .addScaledVector(right, (k('KeyD') - k('KeyA')) * speed);
    this.cam.position.y += (k('KeyE') - k('KeyQ')) * speed;
  }
}

const fly = new FreeFly(camera, canvas);
const hud = new Hud(document.body);
const world = new WorldLoader(scene, '/world/');
let fps = 0;
if (params.get('debug') === '1') {
  const pad = (n: number): string => String(n).padStart(2, '0');
  new DebugOverlay(document.body, () => {
    const d = withDateParam(new Date(), dateOverride);
    const t = parseTimeOverride(timeOverride) ?? { h: d.getHours(), m: d.getMinutes() };
    return {
      x: camera.position.x, y: camera.position.y, z: camera.position.z,
      // inverse of FreeFly.setHeading: yaw = heading + PI
      yawDeg: ((fly.yaw - Math.PI) * 180) / Math.PI, pitchDeg: (fly.pitch * 180) / Math.PI,
      time: `${pad(t.h)}:${pad(t.m)}`, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    };
  }, () => ({
    ...localToWgs84(camera.position.x, camera.position.z), fps,
    drawCalls: renderer.info.render.calls, chunks: world.loadedKeys().size,
  }));
}
// courtyards, forecourts and gaps between buildings
const ground = new Mesh(new PlaneGeometry(6000, 6000), world.street.ground);
ground.rotation.x = -Math.PI / 2;
ground.renderOrder = -1;
ground.receiveShadow = true;
scene.add(ground);

let lighting: Lighting | null = null;
let props: Props | null = null;
let propsRevision = -1;
let sun = currentSun();
let sunAge = 0;
const timer = new Timer();
renderer.setAnimationLoop((t: number) => {
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (dt > 0) fps += (1 / dt - fps) * 0.1;
  fly.update(dt);
  if (lighting && props) {
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
    lighting.update(sun, camera.position);
  }
  renderer.render(scene, camera);
});

const start = devCam ? { x: devCam.x, z: devCam.z } : undefined;
world.init((p) => hud.setProgress(p), start).then((m) => {
  hud.setAttribution(m.attribution);
  if (devCam) {
    camera.position.set(devCam.x, devCam.y, devCam.z);
    fly.setHeading((devCam.yawDeg * Math.PI) / 180, (devCam.pitchDeg * Math.PI) / 180);
  } else {
    camera.position.set(m.spawn.x, m.spawn.y + 1.7, m.spawn.z);
    fly.setHeading(m.spawn.heading);
  }
  props = new Props(scene, m);
  lighting = new Lighting(scene, m.lamps, props.lampGlass, props.halo, world.facade.userData.nightFactor, world.facade.userData.sky);
  hud.hideLoading();
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
  hud.showError('Nippes konnte nicht geladen werden. Bitte lade die Seite neu.');
  window.__nnReady = 'error';
});
