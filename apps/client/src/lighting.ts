import {
  BackSide, Color, DirectionalLight, Fog, HemisphereLight, Mesh, PointLight, ShaderMaterial, SphereGeometry,
  Vector3, type MeshStandardMaterial, type PointsMaterial, type Scene, type IUniform,
} from 'three';
import type { SunState } from '@nn/shared';
import { CLEAR_LOOK, type WeatherLook } from './weather/look';
import { LAMP_LIGHT_Y } from './props';
import { MAX_LAMP_LIGHTS, QUALITY, type Quality } from './quality';
/** Fog end (m) by day at full view distance (quality 'high'); night pulls it in. */
const FULL_VIEW = 650;
/** The lamp light pool is reassigned when the camera has moved farther than this (m). */
export const LAMP_REASSIGN = 10;

type Key = { alt: number; zenith: number; horizon: number; sun: number; sunI: number; hemiSky: number; hemiGround: number; hemiI: number };

/** Light mood by sun altitude (degrees), interpolated between neighbours. Colours sRGB. */
const KEYS: Key[] = [
  { alt: -18, zenith: 0x02050f, horizon: 0x0b1530, sun: 0xff8a50, sunI: 0, hemiSky: 0x3b4f8a, hemiGround: 0x1c1a22, hemiI: 1.8 },
  { alt: -6, zenith: 0x08122e, horizon: 0x1e2c55, sun: 0xff8a50, sunI: 0, hemiSky: 0x4a5a90, hemiGround: 0x1e1c24, hemiI: 1.8 },
  { alt: -2, zenith: 0x1a2c5c, horizon: 0x9a6a6a, sun: 0xff7a40, sunI: 0, hemiSky: 0x6070a0, hemiGround: 0x2a2228, hemiI: 1.5 },
  { alt: 2, zenith: 0x3a5a92, horizon: 0xf0a070, sun: 0xff9a55, sunI: 1.4, hemiSky: 0x8fa2c8, hemiGround: 0x5a4a40, hemiI: 1.2 },
  { alt: 10, zenith: 0x4a78b8, horizon: 0xf2cfa0, sun: 0xffc890, sunI: 2.4, hemiSky: 0xb6c8e2, hemiGround: 0x7a6a58, hemiI: 1.35 },
  { alt: 25, zenith: 0x4f86cc, horizon: 0xc8dcee, sun: 0xffeccf, sunI: 2.8, hemiSky: 0xc4d8f0, hemiGround: 0x8a7e6c, hemiI: 1.45 },
  { alt: 60, zenith: 0x3f7bcc, horizon: 0xbcd6ef, sun: 0xfff4e4, sunI: 3.0, hemiSky: 0xcfe0f5, hemiGround: 0x8a8070, hemiI: 1.5 },
];

export type Mood = { zenith: Color; horizon: Color; sun: Color; sunI: number; hemiSky: Color; hemiGround: Color; hemiI: number };

/** Sky, sun and ambient colours for a sun altitude in degrees (linear colour space). */
export function moodAt(altDeg: number): Mood {
  const a = Math.min(Math.max(altDeg, KEYS[0]!.alt), KEYS[KEYS.length - 1]!.alt);
  let i = 0;
  while (i < KEYS.length - 2 && a > KEYS[i + 1]!.alt) i++;
  const k0 = KEYS[i]!, k1 = KEYS[i + 1]!;
  const t = (a - k0.alt) / (k1.alt - k0.alt);
  const col = (c0: number, c1: number) => new Color(c0).lerp(new Color(c1), t);
  const num = (n0: number, n1: number) => n0 + (n1 - n0) * t;
  return {
    zenith: col(k0.zenith, k1.zenith), horizon: col(k0.horizon, k1.horizon), sun: col(k0.sun, k1.sun),
    sunI: num(k0.sunI, k1.sunI), hemiSky: col(k0.hemiSky, k1.hemiSky), hemiGround: col(k0.hemiGround, k1.hemiGround), hemiI: num(k0.hemiI, k1.hemiI),
  };
}

/** Overcast greys a sky colour towards its own luminance, darkened by this factor. */
const OVERCAST_GREY = 0.75;
/** Share of the sun's intensity the clouds take away at full cover. */
const OVERCAST_SUN_LOSS = 0.8;
/** Share the hemisphere light gains at full cover (diffuse light: soft shadows). */
const OVERCAST_HEMI_GAIN = 0.3;
/** Weather fog never closes in nearer than this (m). */
const MIN_FOG_FAR = 60;
/** Weather fog starts at this share of its far distance at the latest. */
const FOG_NEAR_SHARE = 0.3;
/**
 * Fog far per metre of reported visibility. Linear fog with this far reads like the reported visibility: real fog
 * (a few hundred m) and mist (~1 km) close in visibly even at the short view distance of quality 'low'.
 */
const FOG_VIS_SCALE = 0.35;
/** Below this visibility (m: haze) the fog starts nearer and far shrinks to up to half; at and above it nothing changes. */
const HAZE_VIS = 5000;

function greyTowards(c: Color, k: number): void {
  const g = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * OVERCAST_GREY;
  c.r += (g - c.r) * k;
  c.g += (g - c.g) * k;
  c.b += (g - c.b) * k;
}

/** Applies cloud cover to a mood in place (no allocations). */
function overcastInPlace(m: Mood, overcast: number, night: number): void {
  if (overcast <= 0) return;
  const k = overcast * (1 - night);
  greyTowards(m.zenith, k);
  greyTowards(m.horizon, k);
  m.sunI *= 1 - OVERCAST_SUN_LOSS * overcast;
  m.hemiI *= 1 + OVERCAST_HEMI_GAIN * k;
}

/** The mood under cloud cover 0..1: grey sky (fading out towards night), weak sun, more ambient light. */
export function weatherMood(mood: Mood, overcast: number, night: number): Mood {
  const m: Mood = {
    ...mood, zenith: mood.zenith.clone(), horizon: mood.horizon.clone(), sun: mood.sun.clone(),
    hemiSky: mood.hemiSky.clone(), hemiGround: mood.hemiGround.clone(),
  };
  overcastInPlace(m, overcast, night);
  return m;
}

/** Cloud cover at which the clouds hide the sun glow, moon and stars completely. */
const CLOUD_HIDES = 0.9;

/** How much of the sun glow, moon and stars shows through the clouds (1 clear .. 0 at CLOUD_HIDES), regardless of night. */
export function skyClearness(overcast: number): number {
  return Math.min(1, Math.max(0, 1 - overcast / CLOUD_HIDES));
}

export type FogRange = { near: number; far: number };

/**
 * Fog distances (m) for a visibility (m), written into `out` (no allocation per frame). From HAZE_VIS on the fog stays
 * as it is; below, near moves towards the camera and far shrinks (haze), and far follows the visibility perceptually
 * (FOG_VIS_SCALE) down to MIN_FOG_FAR (fog). Far never grows past `far`, near always stays before far.
 */
export function weatherFog(near: number, far: number, visibility: number, out: FogRange = { near: 0, far: 0 }): FogRange {
  if (!(visibility < HAZE_VIS)) {
    out.near = near;
    out.far = far;
    return out;
  }
  const t = Math.max(0, visibility / HAZE_VIS); // 0 dense fog .. 1 light haze
  const f = Math.min(far, Math.max(MIN_FOG_FAR, Math.min(far * (0.5 + 0.5 * t), visibility * FOG_VIS_SCALE)));
  out.far = f;
  out.near = Math.min(near * t, f * FOG_NEAR_SHARE);
  return out;
}

/** Indices of the `n` lamps nearest to (x, z), nearest first, leaving out those in `skip`. */
export function nearestLamps(lamps: readonly (readonly [number, number])[], x: number, z: number, n: number, skip?: ReadonlySet<number>): number[] {
  return lamps
    .map(([lx, lz], i) => ({ i, d: (lx - x) ** 2 + (lz - z) ** 2 }))
    .filter((e) => !skip?.has(e.i))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((e) => e.i);
}

/** Unit direction towards a body at altitude/azimuth (heading convention: (sin az, cos az) in x/z). */
export function bodyDirection(altitude: number, azimuth: number, out = new Vector3()): Vector3 {
  const c = Math.cos(altitude);
  return out.set(Math.sin(azimuth) * c, Math.sin(altitude), Math.cos(azimuth) * c);
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunCol;
uniform vec3 moonDir;
uniform float night;
uniform float clearSky; // 1 clear .. 0 overcast: hides sun glow, moon and stars
varying vec3 vDir;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float up = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(up, 0.55));
  col = mix(col, horizon * 0.5, smoothstep(0.0, -0.15, d.y)); // below the horizon (hidden by houses)
  float s = max(dot(d, sunDir), 0.0);
  col += clearSky * sunCol * (pow(s, 8.0) * 0.35 + pow(s, 64.0) * 0.6) * smoothstep(-0.12, 0.05, sunDir.y);
  col += clearSky * sunCol * 12.0 * smoothstep(0.9997, 0.99985, s) * step(-0.02, sunDir.y); // disc
  // night: moon disc with a faint halo, stars
  float m = max(dot(d, moonDir), 0.0);
  col += clearSky * night * (vec3(0.9, 0.93, 1.0) * 3.0 * smoothstep(0.99955, 0.9997, m) + vec3(0.12, 0.16, 0.28) * pow(m, 40.0));
  vec3 cell = floor(d * 280.0);
  float star = step(0.9975, h3(cell)) * smoothstep(0.35, 0.0, length(fract(d * 280.0) - 0.5));
  col += clearSky * night * night * star * smoothstep(0.02, 0.25, d.y) * (0.5 + h3(cell + 7.0)) * 0.9;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Sun, moon, sky, fog, shadows and street-lamp lighting, driven by the SunState. */
export class Lighting {
  private readonly sun = new DirectionalLight();
  private readonly moon = new DirectionalLight(0x7d93d6, 0);
  private readonly hemi = new HemisphereLight();
  private readonly fog = new Fog(0xffffff, 150, 650);
  private readonly sky: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly pool: PointLight[] = [];
  private poolAt: { x: number; z: number } | null = null;
  /** Knocked-down lamps: no light. */
  private readonly out = new Set<number>();
  private readonly sunDir = new Vector3();
  /** Pool lights in use (the rest stay hidden: hidden lights cost nothing in the shaders). */
  private lampCount: number = MAX_LAMP_LIGHTS;
  /** Sun shadows are cast within this radius (m) around the camera. */
  private shadowRadius = 0;
  /** Fog distances relative to the full view distance (FULL_VIEW): a lower quality level pulls the fog in. */
  private viewScale = 1;

  constructor(
    private readonly scene: Scene,
    private readonly lamps: readonly (readonly [number, number])[],
    private readonly lampGlass: MeshStandardMaterial,
    private readonly halo: PointsMaterial,
    private readonly facadeNight: IUniform<number>,
    private readonly facadeSky: IUniform<Color>,
    /** Ground height under a lamp (terrain). */
    private readonly groundY: (x: number, z: number) => number = () => 0,
  ) {
    scene.fog = this.fog;
    scene.background = null;
    const s = this.sun.shadow;
    s.camera.near = 1;
    s.camera.far = 900;
    s.bias = -0.0004;
    s.normalBias = 0.06;
    s.radius = 2;
    scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.hemi);
    // the moon stands high in the south-east (no moon phase/orbit in v1)
    bodyDirection(0.75, 0.6, this.moon.position);

    this.sky = new Mesh(
      new SphereGeometry(1500, 32, 16),
      new ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false, fog: false,
        uniforms: {
          zenith: { value: new Color() }, horizon: { value: new Color() }, sunDir: { value: new Vector3() },
          sunCol: { value: new Color() }, moonDir: { value: this.moon.position.clone() }, night: { value: 0 },
          clearSky: { value: 1 },
        },
      }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    for (let i = 0; i < MAX_LAMP_LIGHTS; i++) {
      const l = new PointLight(0xffb36a, 0, 32, 2);
      l.position.set(0, -100, 0);
      this.pool.push(l);
      scene.add(l);
    }
    this.setQuality(QUALITY.high);
  }

  /**
   * Lamp lights and sun shadow of a quality level. A changed number of lights recompiles the scene's materials
   * (a short stall), so this runs only at startup and when the player switches the level.
   */
  setQuality(q: Quality): void {
    this.lampCount = Math.min(q.lampLights, MAX_LAMP_LIGHTS);
    this.pool.forEach((l, i) => { l.visible = i < this.lampCount; });
    this.poolAt = null; // reassign the pool on the next update
    const s = this.sun.shadow;
    s.mapSize.set(q.sunShadow, q.sunShadow); // the shadow map follows on the next render
    this.shadowRadius = q.shadowRadius;
    this.viewScale = q.viewDistance / FULL_VIEW;
    s.camera.left = s.camera.bottom = -q.shadowRadius;
    s.camera.right = s.camera.top = q.shadowRadius;
    s.camera.updateProjectionMatrix();
  }

  /** Lamp i was knocked over: it no longer gets a light. */
  lampOut(i: number): void {
    this.out.add(i);
    this.poolAt = null; // reassign the pool on the next update
  }

  /** Lamp i stands again (server reset): it gets a light back. */
  lampOn(i: number): void {
    if (this.out.delete(i)) this.poolAt = null;
  }

  /** Where the fog turns opaque (m): nothing beyond needs drawing (the camera's far plane). */
  get viewFar(): number {
    return this.fog.far;
  }

  update(sun: SunState, cameraPos: Vector3, look: WeatherLook = CLEAR_LOOK): void {
    const night = sun.nightFactor;
    const mood = moodAt((sun.altitude * 180) / Math.PI);
    overcastInPlace(mood, look.overcast, night); // mood is our own fresh copy
    const dir = bodyDirection(sun.altitude, sun.azimuth, this.sunDir);

    // sky dome follows the camera; fog fades into the horizon colour
    this.sky.position.copy(cameraPos);
    const u = this.sky.material.uniforms;
    u.zenith!.value.copy(mood.zenith);
    u.horizon!.value.copy(mood.horizon);
    u.sunDir!.value.copy(dir);
    u.sunCol!.value.copy(mood.sun);
    u.night!.value = night;
    const clear = skyClearness(look.overcast);
    u.clearSky!.value = clear;
    this.fog.color.copy(mood.horizon);
    const near = (150 - 90 * night) * this.viewScale;
    const far = (FULL_VIEW - 200 * night) * this.viewScale;
    weatherFog(near, far, look.visibility, this.fog);
    this.facadeSky.value.copy(mood.horizon).lerp(mood.zenith, 0.4);
    this.facadeNight.value = night;

    this.hemi.color.copy(mood.hemiSky);
    this.hemi.groundColor.copy(mood.hemiGround);
    this.hemi.intensity = mood.hemiI;

    // sun: directional light with a shadow box of ±shadowRadius around the camera, snapped to texels
    const lit = sun.altitude > 0;
    this.sun.color.copy(mood.sun);
    this.sun.intensity = mood.sunI;
    this.sun.castShadow = lit;
    const texel = (2 * this.shadowRadius) / this.sun.shadow.mapSize.x;
    const t = this.sun.target.position.set(Math.round(cameraPos.x / texel) * texel, cameraPos.y, Math.round(cameraPos.z / texel) * texel);
    this.sun.position.copy(t).addScaledVector(dir, 400);
    this.sun.target.updateMatrixWorld();

    this.moon.intensity = 0.35 * night * clear;

    // lamps: emissive lanterns, halos and real lights at the nearest ones
    this.lampGlass.emissiveIntensity = 6 * night;
    this.halo.opacity = 0.6 * night;
    const at = this.poolAt;
    if (!at || Math.hypot(cameraPos.x - at.x, cameraPos.z - at.z) > LAMP_REASSIGN) {
      this.poolAt = { x: cameraPos.x, z: cameraPos.z };
      const idx = nearestLamps(this.lamps, cameraPos.x, cameraPos.z, this.lampCount, this.out);
      this.pool.forEach((l, i) => {
        const lamp = idx[i] !== undefined ? this.lamps[idx[i]!] : undefined;
        if (lamp) l.position.set(lamp[0], this.groundY(lamp[0], lamp[1]) + LAMP_LIGHT_Y - 0.25, lamp[1]);
        else l.position.set(0, -100, 0);
      });
    }
    for (const l of this.pool) l.intensity = 160 * night;
  }
}
