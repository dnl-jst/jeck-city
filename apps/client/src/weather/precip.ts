import {
  BufferAttribute, BufferGeometry, LineSegments, Points, ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3,
  type Camera, type Scene, type WebGLRenderer,
} from 'three';
import type { Quality } from '../quality';
import { QUALITY } from '../quality';
import type { WeatherLook } from './look';

/** m, edge of the volume around the camera in which drops fall (horizontally; it is PRECIP_HEIGHT tall). */
export const PRECIP_BOX = 40;
/** m, height of the volume: from PRECIP_BELOW under the camera up. */
export const PRECIP_HEIGHT = 30;
export const PRECIP_BELOW = 10;
/** m, the volume's centre lies this far ahead of the camera (horizontally): most drops fall where the viewer looks. */
export const PRECIP_AHEAD = 13;
/**
 * s, the shader's clock wraps after this. Each drop's fall speed is a multiple of PRECIP_HEIGHT / LOOP_S and every
 * wobble frequency a whole number of turns per loop, so after LOOP_S every drop is back where it started: no jump.
 */
export const LOOP_S = 600;

const RAIN_SPEED = 9; // m/s
const RAIN_STREAK = 0.7; // m
const SNOW_SPEED = 1; // m/s
const SNOW_WOBBLE = 0.35; // m
const SNOW_SIZE = 0.11; // m, flake diameter

/** How many of `max` drops fall at intensity 0..1. */
export function visibleDrops(max: number, intensity: number): number {
  return Math.round(max * Math.min(1, Math.max(0, intensity)));
}

/** A fall-speed factor near `f` that makes the drop's fall per loop a whole number of volume heights. */
export function loopSpeed(speed: number, f: number): number {
  const step = PRECIP_HEIGHT / (speed * LOOP_S);
  return Math.max(1, Math.round(f / step)) * step;
}

/**
 * The volume's low corner: centred PRECIP_AHEAD in front of `camera` along the horizontal part of the view direction
 * (dirX, dirZ; any length, (0, 0) = centred), from PRECIP_BELOW under the camera up. Writes into `out`.
 */
export function volumeOrigin(camera: Vector3, dirX: number, dirZ: number, out: Vector3): Vector3 {
  const len = Math.hypot(dirX, dirZ);
  const k = len > 1e-6 ? PRECIP_AHEAD / len : 0;
  return out.set(camera.x + dirX * k - PRECIP_BOX / 2, camera.y - PRECIP_BELOW, camera.z + dirZ * k - PRECIP_BOX / 2);
}

// Shared by both kinds: the drop's head, wrapped into the volume around the camera.
const WRAP = /* glsl */ `
  uniform float time;
  uniform vec3 origin; // low corner of the volume, see volumeOrigin()
  uniform vec2 drift;
  uniform vec2 wind;
  attribute vec4 drop; // xyz: start in the volume, w: fall-speed factor
  vec3 headPos(float fall, vec3 wobble) {
    vec3 box = vec3(${PRECIP_BOX.toFixed(1)}, ${PRECIP_HEIGHT.toFixed(1)}, ${PRECIP_BOX.toFixed(1)});
    vec3 p = drop.xyz + vec3(drift.x, -fall * drop.w * time, drift.y) + wobble;
    return mod(p - origin, box) + origin;
  }
`;

const RAIN_VERT = /* glsl */ `
  ${WRAP}
  attribute float tail; // 0 head, 1 tail
  varying float vAlpha;
  #include <fog_pars_vertex>
  void main() {
    vec3 head = headPos(${RAIN_SPEED.toFixed(1)}, vec3(0.0));
    vec3 vel = vec3(wind.x, -${RAIN_SPEED.toFixed(1)} * drop.w, wind.y);
    vec3 p = head - normalize(vel) * ${RAIN_STREAK.toFixed(2)} * tail;
    vAlpha = 1.0 - tail;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Lit by nothing of its own: a little brighter than the fog (the sky light around), so dim grey by day, faint at night.
const RAIN_FRAG = /* glsl */ `
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    vec3 c = vec3(0.35);
    #ifdef USE_FOG
      c = min(fogColor * 1.4 + 0.06, vec3(0.85));
    #endif
    gl_FragColor = vec4(c, 0.7 * vAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const SNOW_VERT = /* glsl */ `
  ${WRAP}
  attribute vec2 wobble; // x: turns per loop, y: phase
  uniform float pixelScale;
  #include <fog_pars_vertex>
  void main() {
    float a = wobble.x * ${(2 * Math.PI / LOOP_S).toFixed(6)} * time + wobble.y;
    vec3 p = headPos(${SNOW_SPEED.toFixed(1)}, vec3(sin(a), 0.0, cos(a) * 0.6) * ${SNOW_WOBBLE.toFixed(2)});
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(${SNOW_SIZE.toFixed(3)} * pixelScale / -mvPosition.z, 1.5, 16.0);
    #include <fog_vertex>
  }
`;

const SNOW_FRAG = /* glsl */ `
  #include <fog_pars_fragment>
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    vec3 c = vec3(0.8);
    #ifdef USE_FOG
      c = min(fogColor * 1.8 + 0.15, vec3(0.95));
    #endif
    gl_FragColor = vec4(c, 0.95 * (1.0 - smoothstep(0.3, 0.5, r)));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function material(vertexShader: string, fragmentShader: string, extra: Record<string, { value: unknown }> = {}): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader, fragmentShader, transparent: true, depthWrite: false, fog: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      { time: { value: 0 }, origin: { value: new Vector3() }, drift: { value: new Vector2() }, wind: { value: new Vector2() }, ...extra },
    ]),
  });
}

/** Random starts in the volume (origin at 0) with a loop-safe fall-speed factor, `per` vertices per drop. */
function drops(n: number, per: number, speed: number, spread: number): Float32Array {
  const a = new Float32Array(n * per * 4);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * PRECIP_BOX;
    const y = Math.random() * PRECIP_HEIGHT;
    const z = Math.random() * PRECIP_BOX;
    const f = loopSpeed(speed, 1 + (Math.random() * 2 - 1) * spread);
    for (let v = 0; v < per; v++) a.set([x, y, z, f], (i * per + v) * 4);
  }
  return a;
}

/** Rain streaks and snow flakes falling around the camera, animated entirely on the GPU. */
export class Precipitation {
  private readonly rain: LineSegments<BufferGeometry, ShaderMaterial>;
  private readonly snow: Points<BufferGeometry, ShaderMaterial>;
  private max = QUALITY.low.precipDrops;
  private time = 0;
  private readonly drift = new Vector2();
  private readonly cameraPos = new Vector3();
  /** Shared by both materials (their `origin` uniform); set just before drawing, from the drawing camera's view. */
  private readonly origin = new Vector3();

  constructor(scene: Scene) {
    const n = QUALITY.high.precipDrops;

    const rainGeo = new BufferGeometry();
    rainGeo.setAttribute('position', new BufferAttribute(new Float32Array(n * 2 * 3), 3)); // unused, sets the count
    rainGeo.setAttribute('drop', new BufferAttribute(drops(n, 2, RAIN_SPEED, 0.15), 4));
    const tail = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) tail[i * 2 + 1] = 1;
    rainGeo.setAttribute('tail', new BufferAttribute(tail, 1));
    this.rain = new LineSegments(rainGeo, material(RAIN_VERT, RAIN_FRAG));

    const snowGeo = new BufferGeometry();
    snowGeo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    snowGeo.setAttribute('drop', new BufferAttribute(drops(n, 1, SNOW_SPEED, 0.3), 4));
    const wobble = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      wobble[i * 2] = 60 + Math.floor(Math.random() * 80); // ≈ 0.6..1.4 rad/s
      wobble[i * 2 + 1] = Math.random() * Math.PI * 2;
    }
    snowGeo.setAttribute('wobble', new BufferAttribute(wobble, 2));
    this.snow = new Points(snowGeo, material(SNOW_VERT, SNOW_FRAG, { pixelScale: { value: 600 } }));
    const pixelScale = this.snow.material.uniforms.pixelScale!;
    const size = new Vector2();
    // flake size in pixels: half the drawing-buffer height times the projection's vertical scale
    this.snow.onBeforeRender = (renderer: WebGLRenderer, _s: Scene, camera: Camera) => {
      pixelScale.value = renderer.getDrawingBufferSize(size).y * 0.5 * camera.projectionMatrix.elements[5]!;
      this.placeVolume(camera);
    };
    this.rain.onBeforeRender = (_r: WebGLRenderer, _s: Scene, camera: Camera) => this.placeVolume(camera);

    for (const o of [this.rain, this.snow]) {
      o.material.uniforms.origin!.value = this.origin;
      o.frustumCulled = false; // the vertices move in the shader: the bounding sphere means nothing
      o.visible = false;
      o.renderOrder = 1; // after the opaque world and the sky
      scene.add(o);
    }
  }

  setQuality(q: Quality): void {
    this.max = q.precipDrops;
  }

  /** Puts the volume ahead of the drawing camera: its world matrix's third column is the backward (+z) axis. */
  private placeVolume(camera: Camera): void {
    const e = camera.matrixWorld.elements;
    volumeOrigin(this.cameraPos, -e[8]!, -e[10]!, this.origin);
  }

  update(dt: number, camera: Vector3, look: WeatherLook): void {
    this.cameraPos.copy(camera);
    this.time = (this.time + dt) % LOOP_S;
    this.drift.x = (this.drift.x + look.windX * dt) % PRECIP_BOX;
    this.drift.y = (this.drift.y + look.windZ * dt) % PRECIP_BOX;
    this.show(this.rain, look.rain, look);
    this.show(this.snow, look.snow, look);
  }

  private show(o: LineSegments<BufferGeometry, ShaderMaterial> | Points<BufferGeometry, ShaderMaterial>, intensity: number, look: WeatherLook): void {
    const n = visibleDrops(this.max, intensity);
    o.visible = n > 0;
    if (!o.visible) return;
    o.geometry.setDrawRange(0, o instanceof LineSegments ? n * 2 : n);
    const u = o.material.uniforms;
    u.time!.value = this.time;
    (u.drift!.value as Vector2).copy(this.drift);
    (u.wind!.value as Vector2).set(look.windX, look.windZ);
  }
}
