import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh, ShaderMaterial, Vector2, type Scene } from 'three';
import { TUNING } from '@nn/shared';

/** m, the curtain is cut into pieces at most this long, so its foot follows the terrain. */
export const GLOW_STEP = 4;
/** m, the curtain reaches this far above the ground (the invisible physics wall's height). */
export const GLOW_HEIGHT = TUNING.world.boundaryWallHeight;
/** m, the foot starts this far under the ground: no seam where the terrain dips between two samples. */
const GLOW_SINK = 0.3;
/** m, horizontal distance from the player at which the curtain starts to show / is fully lit. */
export const GLOW_FADE_FAR = 40;
export const GLOW_FADE_NEAR = 6;
/** The map's boundary gold (MAP_STYLE.boundary), a bit more saturated: it glows additively. */
const GLOW_COLOR = new Color(1.0, 0.72, 0.32);
/** s, the shader clock wraps after this; both animation speeds make whole turns per loop, so the wrap does not jump. */
const LOOP_S = 600;
const DRIFT = (2 * Math.PI * 120) / LOOP_S; // rad/s, stripes along the wall
const RISE = (2 * Math.PI * 210) / LOOP_S; // rad/s, bands up the wall

/**
 * The curtain's geometry: one vertical quad strip along the closed ring `b` (x,z pairs), from `ground(x, z) - sink`
 * up to `ground + height`, with pieces at most `step` long. uv: u = metres along the ring, v = 0 at the ground, 1 on top.
 */
export function boundaryCurtain(
  b: Float32Array, ground: (x: number, z: number) => number, step = GLOW_STEP, height = GLOW_HEIGHT,
): BufferGeometry {
  const n = b.length / 2;
  const xs: number[] = [], zs: number[] = [], us: number[] = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // the ring is closed: the last point connects back to the first
    const x0 = b[2 * i]!, z0 = b[2 * i + 1]!, x1 = b[2 * j]!, z1 = b[2 * j + 1]!;
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue; // repeated closing point
    const k = Math.ceil(len / step);
    for (let s = 0; s < k; s++) {
      xs.push(x0 + ((x1 - x0) * s) / k);
      zs.push(z0 + ((z1 - z0) * s) / k);
      us.push(u + (len * s) / k);
    }
    u += len;
  }
  // close the strip: the first column again, at the ring's full length (the stripes run on without a jump)
  if (xs.length) {
    xs.push(xs[0]!);
    zs.push(zs[0]!);
    us.push(u);
  }
  const cols = xs.length;
  const pos = new Float32Array(cols * 2 * 3), uv = new Float32Array(cols * 2 * 2);
  for (let c = 0; c < cols; c++) {
    const y = ground(xs[c]!, zs[c]!);
    pos.set([xs[c]!, y - GLOW_SINK, zs[c]!, xs[c]!, y + height, zs[c]!], c * 6);
    uv.set([us[c]!, -GLOW_SINK / height, us[c]!, 1], c * 4);
  }
  const index: number[] = [];
  for (let c = 0; c + 1 < cols; c++) {
    const a = 2 * c, t = a + 1, a2 = a + 2, t2 = a + 3;
    index.push(a, a2, t, t, a2, t2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/**
 * A softly glowing light curtain along the play-area boundary, where the invisible physics walls stand. It only
 * lights up near the player (fully at GLOW_FADE_NEAR, gone beyond GLOW_FADE_FAR): seen from afar the city has no
 * wall of light over its roofs. Brightest at the foot, fading upwards; slow vertical stripes drift along it and
 * soft bands rise up it, so it reads as a barrier and not as a glass pane.
 */
export class BoundaryGlow {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;

  constructor(scene: Scene, boundary: Float32Array, ground: (x: number, z: number) => number) {
    this.mat = new ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        focus: { value: new Vector2() },
        color: { value: GLOW_COLOR },
        strength: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec2 vXZ;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vXZ = w.xz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float time;
        uniform vec2 focus;
        uniform vec3 color;
        uniform float strength;
        varying vec2 vUv;
        varying vec2 vXZ;
        void main() {
          float near = smoothstep(${GLOW_FADE_FAR.toFixed(1)}, ${GLOW_FADE_NEAR.toFixed(1)}, distance(vXZ, focus));
          if (near <= 0.0) discard;
          float v = clamp(vUv.y, 0.0, 1.0);
          float fade = pow(1.0 - v, 0.9);                                   // bright at the foot, gone at the top
          float foot = exp(-v * 14.0);                                      // a bright seam along the ground
          float stripes = 0.45 + 0.55 * sin(vUv.x * 2.4 - time * ${DRIFT.toFixed(5)});      // drifting along the wall
          float bands = 0.75 + 0.25 * sin(v * 18.0 - time * ${RISE.toFixed(5)});           // rising up it
          float a = (0.85 * fade * stripes * bands + 1.2 * foot + 0.12 * fade) * near * strength;
          gl_FragColor = vec4(color * a, 1.0);
        }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    });
    this.mesh = new Mesh(boundaryCurtain(boundary, ground), this.mat);
    this.mesh.frustumCulled = false; // one mesh around the whole city: its bounding sphere always meets the view
    this.mesh.renderOrder = 2; // after the opaque city and the other transparent surfaces it overlaps
    scene.add(this.mesh);
  }

  /** dt: s; (x, z): where the player is; night 0..1: an additive glow needs more in the daylight to show. */
  update(dt: number, x: number, z: number, night: number): void {
    const u = this.mat.uniforms;
    u.time!.value = (u.time!.value + dt) % LOOP_S; // wraps: stays precise in float32 on long sessions
    (u.focus!.value as Vector2).set(x, z);
    u.strength!.value = 1.6 - 0.8 * night;
  }
}
