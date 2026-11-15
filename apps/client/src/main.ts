import {
  ACESFilmicToneMapping, Color, DirectionalLight, Euler, Fog, HemisphereLight, Mesh,
  PerspectiveCamera, PlaneGeometry, Scene, Timer, Vector3, WebGLRenderer,
} from 'three';
import { NoWebGLError } from './errors';
import { Hud } from './hud';
import { WorldLoader } from './loader';

declare global {
  interface Window { __nnReady?: boolean }
}

const params = new URLSearchParams(location.search);
// TEMPORARY dev hook until Task 9 drives nightFactor from the real clock
const night = params.get('night') === '1';

const canvas = document.getElementById('game') as HTMLCanvasElement;
let renderer: WebGLRenderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, reversedDepthBuffer: true });
} catch (err) {
  throw new NoWebGLError(String(err));
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = night ? 1.0 : 1.05;

// placeholder lighting (Task 9 replaces it with sun position and night lighting)
const sky = new Color(night ? 0x0a1230 : 0xa9c8e6);
const scene = new Scene();
scene.background = sky;
scene.fog = new Fog(sky, night ? 80 : 150, 650);
scene.add(night ? new HemisphereLight(0x3a4a80, 0x101018, 0.9) : new HemisphereLight(0xcfe0f5, 0x8a8070, 1.5));
const sun = new DirectionalLight(night ? 0x8090c0 : 0xfff1dc, night ? 0.25 : 2.4);
sun.position.set(-120, 160, 90); // from the south-west, afternoon
scene.add(sun);

// courtyards and gaps between buildings

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
  setHeading(h: number): void {
    // camera looks along -Z at yaw 0; rotating by yaw gives forward (-sin yaw, -cos yaw)
    this.yaw = h + Math.PI;
    this.pitch = 0;
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
// courtyards, forecourts and gaps between buildings
const ground = new Mesh(new PlaneGeometry(6000, 6000), world.street.ground);
ground.rotation.x = -Math.PI / 2;
ground.renderOrder = -1;
scene.add(ground);
world.facade.userData.nightFactor.value = night ? 1 : 0;

const timer = new Timer();
renderer.setAnimationLoop((t: number) => {
  timer.update(t);
  fly.update(Math.min(timer.getDelta(), 0.1));
  world.update(camera.position);
  renderer.render(scene, camera);
});

world.init((p) => hud.setProgress(p)).then((m) => {
  hud.setAttribution(m.attribution);
  camera.position.set(m.spawn.x, m.spawn.y + 1.7, m.spawn.z);
  fly.setHeading(m.spawn.heading);
  hud.hideLoading();
  window.__nnReady = true;
}, (err: unknown) => {
  console.error(err);
});
