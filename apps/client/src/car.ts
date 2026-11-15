import {
  BoxGeometry, BufferAttribute, type BufferGeometry, CanvasTexture, Color, CylinderGeometry, Group,
  AdditiveBlending, type Camera, DataTexture, DataUtils, HalfFloatType, InstancedMesh, LinearFilter, RGBAFormat, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SpotLight, Sprite, SpriteMaterial,
  SRGBColorSpace, Vector3, type Scene,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TUNING, VEHICLE_REST_Y, type CarPool, type CarPose } from '@nn/shared';

type XZ = { x: number; z: number };

// ---------------------------------------------------------------- model

/** Ground level in the chassis frame (the physics chassis centre rests VEHICLE_REST_Y above the road). */
const G = -VEHICLE_REST_Y;
const V = TUNING.vehicle;

function painted(g: BufferGeometry, hex: number): BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const c = new Color(hex);
  const n = ng.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  ng.setAttribute('color', new BufferAttribute(col, 3));
  return ng;
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts);
  if (!g) throw new Error('car: geometry merge failed');
  return g;
}

/** Box whose top face is narrowed by `inset` (x) and shifted/shortened by `front`/`back` (z): a cabin with sloped screens. */
function cabin(w: number, h: number, l: number, inset: number, front: number, back: number): BufferGeometry {
  const g = new BoxGeometry(w, h, l);
  const p = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) <= 0) continue;
    p.setX(i, p.getX(i) - Math.sign(p.getX(i)) * inset);
    p.setZ(i, p.getZ(i) > 0 ? p.getZ(i) - front : p.getZ(i) + back);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Low-poly compact estate car in the chassis frame (+z forward, +x left, ground at y = G), split into
 * paint (body colour), trim (glass, tyres, bumpers, plates: vertex colours), head- and taillights.
 */
export function carGeometries(): { paint: BufferGeometry; trim: BufferGeometry; head: BufferGeometry; tail: BufferGeometry } {
  const L = 4.1, W = 1.76;
  const sill = G + 0.3, belt = G + 0.92, roof = G + 1.47;
  const box = (w: number, h: number, l: number, x: number, y: number, z: number) => new BoxGeometry(w, h, l).translate(x, y, z);
  const paint = merged([
    painted(box(W, belt - sill, L, 0, (belt + sill) / 2, 0), 0xffffff),
    // bonnet slightly lower than the belt line at the front
    painted(cabin(W - 0.04, 0.06, 1.2, 0.05, 0.2, 0).translate(0, belt + 0.01, L / 2 - 0.62), 0xffffff),
    painted(box(1.42, 0.07, 2.05, 0, roof - 0.035, -0.55), 0xffffff),
    ...[1, -1].map((s) => painted(box(0.12, 0.1, 0.18, s * (W / 2 + 0.04), belt + 0.1, 0.55), 0xffffff)), // mirrors
  ]);
  const glassH = roof - 0.07 - belt;
  const trim = merged([
    painted(cabin(W - 0.12, glassH, 2.75, 0.13, 0.62, 0.08).translate(0, belt + glassH / 2, -0.38), 0x1a2229),
    painted(box(W + 0.02, 0.2, 0.18, 0, sill + 0.08, L / 2 + 0.02), 0x2a2c2e), // bumpers
    painted(box(W + 0.02, 0.22, 0.18, 0, sill + 0.09, -L / 2 - 0.02), 0x2a2c2e),
    painted(box(W - 0.02, 0.14, L - 0.3, 0, sill - 0.04, 0), 0x202224), // sills / underbody
    painted(box(0.52, 0.12, 0.02, 0, sill + 0.1, L / 2 + 0.12), 0xf2f2ec), // number plates
    painted(box(0.52, 0.12, 0.02, 0, sill + 0.3, -L / 2 - 0.01), 0xf2f2ec),
    ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].flatMap(([sx, sz]) => {
      const at = (g: BufferGeometry) => g.rotateZ(Math.PI / 2).translate(sx! * V.wheelX, G + V.wheelRadius, sz! * V.wheelZ);
      return [painted(at(new CylinderGeometry(V.wheelRadius, V.wheelRadius, 0.22, 14)), 0x141414),
        painted(at(new CylinderGeometry(0.2, 0.2, 0.235, 10)), 0x8d9296)];
    }),
  ]);
  const head = merged([1, -1].map((s) => painted(box(0.36, 0.13, 0.04, s * 0.6, belt - 0.12, L / 2 + 0.005), 0xe8e6dc)));
  const tail = merged([1, -1].map((s) => painted(box(0.18, 0.26, 0.04, s * 0.74, belt - 0.16, -L / 2 - 0.005), 0x7a0e0e)));
  return { paint, trim, head, tail };
}

const paintMaterial = (): MeshStandardMaterial => new MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.35 });
const trimMaterial = (): MeshStandardMaterial => new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });

/** Peak luminous intensity of one headlight at night (cd, three.js physical units). */
export const HEADLIGHT_INTENSITY = 60000;
/** Half-angle of the spotlight cone (rad); the beam pattern texture shapes the light inside it. */
const BEAM_ANGLE = 0.9;
/** The beam axis points this far below the horizontal (rad); the pattern itself carries the low-beam cutoff. */
const BEAM_TILT = 0;
/** Light reach (m): intensity falls smoothly to zero here (on top of the inverse-square falloff). */
const BEAM_RANGE = 65;
/** Red glow the tail lamps throw behind the car (cd per lamp): position lights at night, and brake lights. */
export const TAIL_INTENSITY = 6;
export const BRAKE_INTENSITY = 30;

/** Lamp power 0..1 from the ignition's light level: dark, flickering while the starter turns (new each call), full. */
export const lampPower = (level: 0 | 0.5 | 1, rand: () => number): number => (level === 0.5 ? 0.25 + 0.35 * rand() : level);

/**
 * Low-beam pattern, linear 0..1, as a function of the direction off the beam axis given as tangents
 * (x = sideways, y = up; the road d metres ahead lies at y ≈ -0.8 / d).
 *
 * The lamps sit 0.8 m above the road, so the road 20 m ahead is hit at a grazing ~2° and catches only a few
 * per cent of the light. Like a real low beam, the pattern therefore peaks just below a soft horizontal cutoff
 * (~1.6° down, meeting the road 22–28 m ahead) and falls off steeply downwards (∝ 1/angle^2.5), which keeps
 * the road evenly lit from the bumper to the cutoff. Above it only a faint spill remains, enough to pick
 * nearby facades out of the dark; nothing reaches far down the street like a high beam would.
 */
export function beamPattern(x: number, y: number): number {
  const cut = -0.029, knee = 0.022, spill = 0.01;
  const a = cut + 0.014 - y; // angle below the cutoff
  const below = a <= knee ? 1 : (knee / a) ** 2.5;
  const t = Math.min(1, Math.max(0, (y - cut) / 0.009));
  const vertical = below * (1 - t * t * (3 - 2 * t)) + spill * Math.exp(-((y / 0.22) ** 2)) * t;
  const spread = 0.42 + 1.1 * Math.min(1, Math.max(0, -y - 0.04)); // wide in the near field, so no wedge beside the car
  return vertical * Math.exp(-((x / spread) ** 2));
}

/**
 * The pattern as a linear half-float texture: the near field is lit with only ~0.2 % of the peak, where 8-bit
 * texels would show as coloured contour rings on the road.
 */
function beamTexture(): DataTexture {
  // tall texture: the interesting part of the pattern is a few rows around the cutoff
  const w = 256, h = 1024, tan = Math.tan(BEAM_ANGLE);
  const data = new Uint16Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const u = ((i + 0.5) / w) * 2 - 1, v = ((j + 0.5) / h) * 2 - 1; // row 0 = bottom of the beam
      const r = Math.min(1, Math.hypot(u, v) / 0.97);
      const k = beamPattern(u * tan, v * tan) * (1 - r * r) ** 1.5; // fades out well inside the cone: no hard rim
      const o = (j * w + i) * 4;
      // warm-white halogen tint
      data[o] = DataUtils.toHalfFloat(k);
      data[o + 1] = DataUtils.toHalfFloat(k * 0.9);
      data[o + 2] = DataUtils.toHalfFloat(k * 0.72);
      data[o + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const t = new DataTexture(data, w, h, RGBAFormat, HalfFloatType);
  t.minFilter = t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Radial glare: a hot core with a long soft falloff (white; tinted per lamp via the material colour). */
function haloTexture(): CanvasTexture {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const r = Math.hypot((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5) * 2;
      const k = r >= 1 ? 0 : (Math.exp(-r * r * 60) + 0.35 * Math.exp(-r * r * 9) + 0.12 * Math.exp(-r * 3.5)) * (1 - r) ** 2;
      const o = (j * n + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.min(255, 255 * k);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new CanvasTexture(c);
}

/** Thin horizontal streak, brightest in the middle (an anamorphic-style flare line). */
function streakTexture(): CanvasTexture {
  const w = 256, h = 32;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = ((i + 0.5) / w) * 2 - 1, y = ((j + 0.5) / h) * 2 - 1;
      const k = Math.exp(-y * y * 30) * (1 - x * x) ** 3 * (0.4 + 0.6 * Math.exp(-x * x * 12));
      const o = (j * w + i) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 * k;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new CanvasTexture(c);
}

/** Is the straight line between two world points blocked (by buildings, walls…)? */
export type Occluded = (from: Vector3, to: Vector3) => boolean;

/** How strongly a lamp facing `forward` glares at a viewer in direction `toViewer` (both unit): 0 beside/behind, 1 head-on. */
export function glareFacing(forward: Vector3, toViewer: Vector3, sharpness: number): number {
  return Math.max(0, forward.dot(toViewer)) ** sharpness;
}

/**
 * Lens glare of one lamp: a halo and a horizontal streak, drawn on top of everything (constant screen size)
 * and faded by how directly the lamp faces the camera; a ray towards the camera hides it behind buildings.
 */
class Glare {
  private readonly halo: Sprite;
  private readonly streak: Sprite;
  private readonly world = new Vector3();
  private readonly fwd = new Vector3();
  private readonly to = new Vector3();
  private shown = 0;

  constructor(
    parent: Group, private readonly at: Vector3, private readonly forward: Vector3,
    color: number, private readonly size: number, private readonly sharpness: number, private readonly streakGain: number, maps: { halo: CanvasTexture; streak: CanvasTexture },
  ) {
    const mat = (map: CanvasTexture) => new SpriteMaterial({
      map, color, blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, opacity: 0,
    });
    this.halo = new Sprite(mat(maps.halo));
    this.streak = new Sprite(mat(maps.streak));
    for (const sp of [this.halo, this.streak]) {
      sp.position.copy(at);
      sp.renderOrder = 20;
      sp.frustumCulled = false;
      sp.visible = false;
      parent.add(sp);
    }
  }

  /** k = lamp brightness 0..1 (night, brake…); dt smooths the occlusion fade. */
  update(camera: Camera, parent: Group, k: number, occluded: Occluded, dt: number): void {
    let want = 0;
    if (k > 0.01) {
      this.world.copy(this.at).applyMatrix4(parent.matrixWorld);
      this.fwd.copy(this.forward).transformDirection(parent.matrixWorld);
      this.to.copy(camera.position).sub(this.world);
      const d = this.to.length();
      this.to.divideScalar(d);
      const f = glareFacing(this.fwd, this.to, this.sharpness);
      // a lamp only glares when its glass is visible: the hood/boot hides it shortly off-axis, buildings fully
      if (f > 0.002 && !occluded(this.world, camera.position)) want = k * f * Math.min(1, 14 / Math.max(d, 1)) ** 0.5;
    }
    this.shown += (want - this.shown) * Math.min(1, dt * 18);
    const o = this.shown;
    const vis = o > 0.003;
    this.halo.visible = this.streak.visible = vis;
    if (!vis) return;
    this.halo.material.opacity = Math.min(1, o * 1.4);
    this.halo.scale.setScalar(this.size * (0.5 + 0.5 * o));
    this.streak.material.opacity = o * 0.8 * this.streakGain;
    this.streak.scale.set(this.size * (1.6 + 2.4 * o), this.size * 0.09, 1);
  }

  hide(): void {
    this.shown = 0;
    this.halo.visible = this.streak.visible = false;
  }
}

/**
 * The car being driven: a regular mesh group with emissive head- and taillights (× nightFactor) and brake lights,
 * plus two real, shadow-casting spotlights so the beams light the road, cars and facades.
 * The spotlights live in their own always-visible rig: three.js recompiles every material when the number of
 * lights changes, so they are never removed, only dimmed to zero (with their shadow maps frozen) when unused.
 */
export class DrivenCar {
  readonly group = new Group();
  private readonly rig = new Group();
  private readonly beams: SpotLight[] = [];
  private readonly tails: SpotLight[] = [];
  private readonly glares: { glare: Glare; head: boolean }[] = [];
  private headK = 0;
  private tailK = 0;
  private shown = false;
  private readonly paint = paintMaterial();
  private readonly headMat = new MeshStandardMaterial({ color: 0xe8e6dc, emissive: 0xfff1d6, roughness: 0.2 });
  private readonly tailMat = new MeshStandardMaterial({ color: 0x7a0e0e, emissive: 0xff1a0a, roughness: 0.3 });

  constructor(scene: Scene) {
    const g = carGeometries();
    const parts = [new Mesh(g.paint, this.paint), new Mesh(g.trim, trimMaterial()), new Mesh(g.head, this.headMat), new Mesh(g.tail, this.tailMat)];
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; }
    this.group.add(...parts);
    this.group.visible = false;
    scene.add(this.group);

    const map = beamTexture();
    for (const s of [1, -1]) {
      const l = new SpotLight(0xffffff, 0, BEAM_RANGE, BEAM_ANGLE, 0, 2);
      l.map = map;
      // just ahead of the lamp glass, so the car's own body never shadows its beam
      l.position.set(s * 0.6, G + 0.8, 2.2);
      l.target.position.set(s * 0.6 + s * 0.6, G + 0.8 - Math.tan(BEAM_TILT) * 30, 2.2 + 30); // toe out a little
      l.castShadow = true;
      l.shadow.mapSize.set(1024, 1024);
      l.shadow.camera.near = 0.3;
      l.shadow.camera.far = BEAM_RANGE;
      l.shadow.bias = -0.0006;
      l.shadow.normalBias = 0.05;
      l.shadow.radius = 3;
      l.shadow.autoUpdate = false;
      this.rig.add(l, l.target);
      this.beams.push(l);
    }
    // tail lamps: wide, soft red cones onto the road and whatever stands behind (no shadows, they are dim)
    for (const s of [1, -1]) {
      const l = new SpotLight(0xff2a14, 0, 18, 1.15, 1, 2);
      l.position.set(s * 0.74, G + 0.76, -2.2);
      l.target.position.set(s * 0.9, G - 0.6, -10);
      this.rig.add(l, l.target);
      this.tails.push(l);
    }
    const maps = { halo: haloTexture(), streak: streakTexture() };
    for (const s of [1, -1]) {
      this.glares.push({ head: true, glare: new Glare(this.group, new Vector3(s * 0.6, G + 0.8, 2.13), new Vector3(0, 0, 1), 0xfff2dc, 0.55, 3, 1, maps) });
      this.glares.push({ head: false, glare: new Glare(this.group, new Vector3(s * 0.74, G + 0.76, -2.13), new Vector3(0, 0, -1), 0xff2a14, 0.22, 2, 0.35, maps) });
    }
    scene.add(this.rig);
  }

  /** Lens glare of head- and tail lamps for the current camera; call after setPose/setLights, before rendering. */
  updateGlare(camera: Camera, occluded: Occluded, dt: number): void {
    if (!this.shown) return;
    this.group.updateMatrixWorld();
    for (const { glare, head } of this.glares) glare.update(camera, this.group, head ? this.headK : this.tailK, occluded, dt);
  }

  show(color: number): void {
    this.paint.color.setHex(color);
    this.group.visible = true;
    this.shown = true;
  }

  hide(): void {
    this.group.visible = false;
    this.shown = false;
    this.setBeams(0);
    for (const l of this.tails) l.intensity = 0;
    for (const { glare } of this.glares) glare.hide();
  }

  setPose(p: CarPose): void {
    for (const o of [this.group, this.rig]) {
      o.position.set(p.x, p.y, p.z);
      o.quaternion.set(p.qx, p.qy, p.qz, p.qw);
    }
  }

  /** night 0..1; braking lights the tail lamps fully by day too; power 0..1 (ignition: off, flickering, on) scales everything. */
  setLights(night: number, braking: boolean, power: number): void {
    const brake = braking && power > 0.5;
    this.headMat.emissiveIntensity = (0.15 + 2.2 * night) * power;
    this.tailMat.emissiveIntensity = (brake ? 2.5 : 0.08 + 1.1 * night) * power;
    this.setBeams(this.shown && power > 0.5 ? night * power : 0);
    const tail = !this.shown ? 0 : brake ? BRAKE_INTENSITY : TAIL_INTENSITY * night;
    for (const l of this.tails) l.intensity = tail * power;
    this.headK = night * power;
    this.tailK = (brake ? 1 : 0.3 * night) * power;
  }

  private setBeams(k: number): void {
    const on = k > 0.02;
    for (const l of this.beams) {
      l.intensity = on ? HEADLIGHT_INTENSITY * k : 0;
      l.shadow.autoUpdate = on;
    }
  }
}

// ---------------------------------------------------------------- parked cars

/** Parked cars are drawn only within this distance of the camera (m)… */
export const CAR_RENDER_RADIUS = 250;
/** …and that set is rebuilt only after the camera moved more than this since the last rebuild (m). */
export const CAR_REBUILD_MOVE = 20;

/** Indices (ascending) of the cars within `radius` of (x, z), plus the `always` ones (physics-active, occupied). */
export function visibleCars(poses: readonly XZ[], x: number, z: number, radius = CAR_RENDER_RADIUS, always: Iterable<number> = []): number[] {
  const keep = new Set(always);
  const out: number[] = [];
  const r2 = radius * radius;
  for (let i = 0; i < poses.length; i++) {
    const dx = poses[i]!.x - x, dz = poses[i]!.z - z;
    if (keep.has(i) || dx * dx + dz * dz <= r2) out.push(i);
  }
  return out;
}

/** Whether the visible car set must be rebuilt: never built, or the camera moved more than CAR_REBUILD_MOVE since. */
export const needsCarRebuild = (last: XZ | null, x: number, z: number): boolean =>
  !last || Math.hypot(x - last.x, z - last.z) > CAR_REBUILD_MOVE;

/**
 * Draws the cars of the sim's CarPool. Those within CAR_RENDER_RADIUS of the camera render as two InstancedMeshes
 * (paint coloured per instance, trim; update() packs them into the first instance slots); the own car is hidden
 * (DrivenCar draws it). Poses come from pool.poses, which the sim replaces (new object) whenever a car moves.
 */
export class ParkedCars {
  private readonly paint: InstancedMesh;
  private readonly trim: InstancedMesh;
  /** The car the player drives: not drawn here. */
  private own: number | null = null;
  /** Instance slot of each car, −1 while it is not drawn. */
  private readonly slots: Int32Array;
  /** Cars with an instance slot, and the pose object last written for each car. */
  private shown: number[] = [];
  private readonly drawn: (CarPose | null)[];
  private lastRebuild: XZ | null = null;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly zero = new Vector3(0, 0, 0);

  constructor(scene: Scene, private readonly pool: CarPool) {
    const n = pool.count;
    const g = carGeometries();
    this.paint = new InstancedMesh(g.paint, paintMaterial(), n);
    this.trim = new InstancedMesh(merged([g.trim, g.head, g.tail]), trimMaterial(), n);
    this.slots = new Int32Array(n).fill(-1);
    this.drawn = new Array<CarPose | null>(n).fill(null);
    this.paint.setColorAt(0, new Color()); // allocate instanceColor
    for (const im of [this.paint, this.trim]) {
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      scene.add(im);
    }
  }

  get count(): number {
    return this.pool.count;
  }

  /** Hides car i (the one the player now drives; null = none) and shows the previous one again. */
  setOwn(i: number | null): void {
    const old = this.own;
    this.own = i;
    for (const c of [old, i]) if (c !== null) this.drawn[c] = null; // rewritten (scale) by the next update()
  }

  /** Cars that must have an instance slot regardless of distance: those with physics (near a player) or a driver. */
  private always(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.pool.count; i++) if (this.pool.vehicle(i) || this.pool.driver[i] !== null) out.push(i);
    return out;
  }

  /**
   * Per frame, with the camera at (x, z): draws the cars within CAR_RENDER_RADIUS plus every always-drawn one
   * (rebuilt after CAR_REBUILD_MOVE of movement or when an always-drawn car has no slot yet), and rewrites the
   * matrices of the drawn cars whose pose changed.
   */
  update(x: number, z: number): void {
    const always = this.always();
    if (needsCarRebuild(this.lastRebuild, x, z) || !always.every((i) => this.slots[i]! >= 0)) this.rebuild(x, z, always);
    let changed = false;
    for (const i of this.shown) {
      if (this.pool.poses[i] === this.drawn[i]) continue;
      this.writeMatrix(i);
      changed = true;
    }
    if (changed) this.flush();
  }

  private rebuild(x: number, z: number, always: number[]): void {
    this.lastRebuild = { x, z };
    this.shown = visibleCars(this.pool.poses, x, z, CAR_RENDER_RADIUS, always);
    this.slots.fill(-1);
    const col = new Color();
    this.shown.forEach((i, k) => {
      this.slots[i] = k;
      this.paint.setColorAt(k, col.setHex(this.pool.colors[i]!));
      this.writeMatrix(i);
    });
    for (const im of [this.paint, this.trim]) {
      im.count = this.shown.length;
      im.computeBoundingSphere();
    }
    this.paint.instanceColor!.needsUpdate = true;
    this.flush();
  }

  private writeMatrix(i: number): void {
    const k = this.slots[i]!;
    if (k < 0) return;
    const s = this.pool.poses[i]!;
    this.drawn[i] = s;
    this.m.compose(this.p.set(s.x, s.y, s.z), this.q.set(s.qx, s.qy, s.qz, s.qw), i === this.own ? this.zero : this.one);
    this.paint.setMatrixAt(k, this.m);
    this.trim.setMatrixAt(k, this.m);
  }

  private flush(): void {
    this.paint.instanceMatrix.needsUpdate = true;
    this.trim.instanceMatrix.needsUpdate = true;
  }
}
