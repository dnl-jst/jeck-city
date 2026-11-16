import {
  type BufferGeometry, CanvasTexture, Color, Group, type Material, type Object3D,
  AdditiveBlending, type Camera, DataTexture, DataUtils, HalfFloatType, InstancedMesh, LinearFilter, RGBAFormat, Matrix4, type Mesh, MeshStandardMaterial, Quaternion, SpotLight, Sprite, SpriteMaterial,
  Vector3, type Scene,
} from 'three';
import {
  CAR_SPECS, SUSPENSION_REST_LENGTH, TUNING, VEHICLE_REST_Y, type CarPool, type CarPose, type CarType,
} from '@nn/shared';

type XZ = { x: number; z: number };

// ---------------------------------------------------------------- model

/** Car model templates per type (WorldLoader.loadCarModels): full detail and the distance version. */
export type CarModels = ReadonlyMap<CarType, { full: Object3D; lod: Object3D }>;

/** The models stand on the ground at their origin; the chassis frame origin is VEHICLE_REST_Y above it. */
const MODEL_TO_CHASSIS = new Matrix4().makeTranslation(0, -VEHICLE_REST_Y, 0);
/** Ground level in the chassis frame. */
const G = -VEHICLE_REST_Y;

type Part = { geometry: BufferGeometry; material: Material; local: Matrix4 };

/** Every mesh of a model with its matrix in the chassis frame (one instanced mesh each). */
function modelParts(model: Object3D): Part[] {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const out: Part[] = [];
  model.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const local = MODEL_TO_CHASSIS.clone().multiply(inv.clone().multiply(m.matrixWorld));
    for (const mat of [m.material].flat()) out.push({ geometry: m.geometry, material: mat, local });
  });
  return out;
}

/** Paint is white in the instanced copy: instanceColor carries each car's colour. */
function instanceMaterial(m: Material): Material {
  if (!(m instanceof MeshStandardMaterial) || m.name !== 'paint') return m;
  const c = m.clone();
  c.color.set(0xffffff);
  return c;
}

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

/** Lamp power 0..1 for an ignition light level: off, flickering while cranking (rand: 0..1), on. */
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
    parent: Group, readonly at: Vector3, private readonly forward: Vector3,
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

  /** Moves the lamp (chassis frame). */
  place(at: Vector3): void {
    this.at.copy(at);
    this.halo.position.copy(at);
    this.streak.position.copy(at);
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

/** What the wheels follow: a Vehicle, or a stand-in built from a streamed car state. */
export type WheelSource = { speed(): number; wheelSteering(w: number): number; wheelSuspension(w: number): number };

/** Wheel nodes in Vehicle wheel order (0 front right, 1 front left, 2 rear right, 3 rear left). */
const WHEEL_NODES = ['wheel_fr', 'wheel_fl', 'wheel_rr', 'wheel_rl'] as const;
/** How far the suspension may visibly move a wheel from its rest position (m). */
const WHEEL_TRAVEL = 0.12;

/** One driveable copy of a car model: its own paint and lamp materials, wheel nodes, lamp positions. */
type Rig = {
  root: Object3D;
  paint: MeshStandardMaterial[];
  head: MeshStandardMaterial[];
  tail: MeshStandardMaterial[];
  wheels: { node: Object3D; rest: Vector3 }[];
  /** Lamp centres in the chassis frame: front left/right, rear left/right. */
  lamps: { fl: Vector3; fr: Vector3; rl: Vector3; rr: Vector3 };
};

function makeRig(model: Object3D, type: CarType): Rig {
  const root = model.clone(true);
  root.position.set(0, -VEHICLE_REST_Y, 0);
  const paint: MeshStandardMaterial[] = [], head: MeshStandardMaterial[] = [], tail: MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.castShadow = m.receiveShadow = true;
    const own = (mat: Material): Material => {
      if (!(mat instanceof MeshStandardMaterial)) return mat;
      if (mat.name === 'paint') { const c = mat.clone(); paint.push(c); return c; }
      if (mat.name === 'lamp_front') { const c = mat.clone(); c.emissive.set(0xfff1d6); head.push(c); return c; }
      if (mat.name === 'lamp_rear') { const c = mat.clone(); c.emissive.set(0xff1a0a); tail.push(c); return c; }
      return mat;
    };
    m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material);
  });
  const wheels = WHEEL_NODES.map((n) => {
    const node = root.getObjectByName(n);
    if (!node) throw new Error(`car model ${type}: node ${n} missing`);
    return { node, rest: node.position.clone() };
  });
  const lamp = (n: string, fallback: Vector3): Vector3 => {
    const e = root.getObjectByName(n);
    return e ? e.position.clone().add(new Vector3(0, -VEHICLE_REST_Y, 0)) : fallback;
  };
  const sp = CAR_SPECS[type];
  const fz = sp.bodyZ + sp.length / 2, rz = sp.bodyZ - sp.length / 2;
  return {
    root, paint, head, tail, wheels,
    lamps: {
      fl: lamp('light_fl', new Vector3(0.6, G + 0.75, fz)), fr: lamp('light_fr', new Vector3(-0.6, G + 0.75, fz)),
      rl: lamp('tail_l', new Vector3(0.7, G + 0.85, rz)), rr: lamp('tail_r', new Vector3(-0.7, G + 0.85, rz)),
    },
  };
}

/**
 * The car being driven: a clone of its type's model with its own paint and emissive head- and taillights
 * (× nightFactor) and brake lights, wheels that spin, steer and follow the suspension, plus two real,
 * shadow-casting spotlights so the beams light the road, cars and facades.
 * The spotlights live in their own always-visible rig: three.js recompiles every material when the number of
 * lights changes, so they are never removed, only dimmed to zero (with their shadow maps frozen) when unused.
 */
export class DrivenCar {
  readonly group = new Group();
  private readonly rig = new Group();
  private readonly beams: SpotLight[] = [];
  private readonly tails: SpotLight[] = [];
  private readonly glares: { glare: Glare; head: boolean; side: 'l' | 'r' }[] = [];
  private readonly rigs = new Map<CarType, Rig>();
  private current: Rig | null = null;
  private spin = 0;
  private radius: number = TUNING.vehicle.wheelRadius;
  private headK = 0;
  private tailK = 0;
  private shown = false;
  private readonly qSteer = new Quaternion();
  private readonly qSpin = new Quaternion();
  private readonly axisX = new Vector3(1, 0, 0);
  private readonly axisY = new Vector3(0, 1, 0);

  /**
   * beams: false = another player's car: no spotlights (only the emissive lamp materials and glare sprites), so the
   * scene's light count stays constant and no extra shadow maps are rendered.
   */
  constructor(scene: Scene, private readonly models?: CarModels, { beams = true }: { beams?: boolean } = {}) {
    this.group.visible = false;
    scene.add(this.group);

    const map = beams ? beamTexture() : null;
    for (let k = 0; k < (beams ? 2 : 0); k++) {
      const l = new SpotLight(0xffffff, 0, BEAM_RANGE, BEAM_ANGLE, 0, 2);
      l.map = map!;
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
    for (let k = 0; k < (beams ? 2 : 0); k++) {
      const l = new SpotLight(0xff2a14, 0, 18, 1.15, 1, 2);
      this.rig.add(l, l.target);
      this.tails.push(l);
    }
    const maps = { halo: haloTexture(), streak: streakTexture() };
    for (const side of ['l', 'r'] as const) {
      this.glares.push({ head: true, side, glare: new Glare(this.group, new Vector3(), new Vector3(0, 0, 1), 0xfff2dc, 0.55, 3, 1, maps) });
      this.glares.push({ head: false, side, glare: new Glare(this.group, new Vector3(), new Vector3(0, 0, -1), 0xff2a14, 0.22, 2, 0.35, maps) });
    }
    this.placeLamps({ fl: new Vector3(0.6, G + 0.8, 2.1), fr: new Vector3(-0.6, G + 0.8, 2.1), rl: new Vector3(0.74, G + 0.76, -2.1), rr: new Vector3(-0.74, G + 0.76, -2.1) });
    scene.add(this.rig);
  }

  /** Spotlights and glare sprites at the lamps of the current model. */
  private placeLamps(l: Rig['lamps']): void {
    [l.fl, l.fr].forEach((p, k) => {
      const b = this.beams[k], s = Math.sign(p.x) || 1;
      if (!b) return; // no spotlights (beams: false)
      // just ahead of the lamp glass, so the car's own body never shadows its beam
      b.position.set(p.x, p.y, p.z + 0.08);
      b.target.position.set(p.x + s * 0.6, p.y - Math.tan(BEAM_TILT) * 30, p.z + 30); // toe out a little
    });
    [l.rl, l.rr].forEach((p, k) => {
      const t = this.tails[k];
      if (!t) return;
      t.position.set(p.x, p.y, p.z - 0.05);
      t.target.position.set(p.x + Math.sign(p.x) * 0.16, G - 0.6, p.z - 8);
    });
    for (const { glare, head, side } of this.glares) glare.place(head ? (side === 'l' ? l.fl : l.fr) : side === 'l' ? l.rl : l.rr);
  }

  /** Lens glare of head- and tail lamps for the current camera; call after setPose/setLights, before rendering. */
  updateGlare(camera: Camera, occluded: Occluded, dt: number): void {
    if (!this.shown) return;
    this.group.updateMatrixWorld();
    for (const { glare, head } of this.glares) glare.update(camera, this.group, head ? this.headK : this.tailK, occluded, dt);
  }

  show(type: CarType, color: number): void {
    let r = this.rigs.get(type);
    const model = this.models?.get(type)?.full;
    if (!r && model) {
      r = makeRig(model, type);
      this.rigs.set(type, r);
    }
    if (this.current) this.group.remove(this.current.root);
    this.current = r ?? null;
    this.radius = CAR_SPECS[type].wheelRadius;
    if (r) {
      this.group.add(r.root);
      for (const m of r.paint) m.color.setHex(color);
      this.placeLamps(r.lamps);
    }
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

  /** Wheels: spin with the speed (m/s), steer and follow each wheel's suspension; dt = frame time. */
  setWheels(v: WheelSource, dt: number): void {
    const r = this.current;
    if (!r) return;
    this.spin = (this.spin + (v.speed() * dt) / this.radius) % (Math.PI * 2);
    this.qSpin.setFromAxisAngle(this.axisX, this.spin);
    r.wheels.forEach(({ node, rest }, i) => {
      this.qSteer.setFromAxisAngle(this.axisY, i < 2 ? v.wheelSteering(i) : 0);
      node.quaternion.copy(this.qSteer).multiply(this.qSpin);
      const lift = Math.max(-WHEEL_TRAVEL, Math.min(WHEEL_TRAVEL, SUSPENSION_REST_LENGTH - v.wheelSuspension(i)));
      node.position.set(rest.x, rest.y + lift, rest.z);
    });
  }

  /** night 0..1; braking lights the tail lamps fully by day too; power 0..1 (ignition: off, flickering, on) scales everything. */
  setLights(night: number, braking: boolean, power: number): void {
    const brake = braking && power > 0.5;
    const r = this.current;
    if (r) {
      for (const m of r.head) m.emissiveIntensity = (0.15 + 2.2 * night) * power;
      for (const m of r.tail) m.emissiveIntensity = (brake ? 2.5 : 0.08 + 1.1 * night) * power;
    }
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
export const CAR_RENDER_RADIUS = 150;
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

/** Parked cars closer to the camera than this use the full model, the rest the distance version (m). */
export const CAR_LOD_NEAR = 45;

/** Instanced meshes of one model (one per part); level 0 = full detail, 1 = distance version. */
type Level = { parts: Part[]; meshes: InstancedMesh[]; paint: boolean[]; used: number };

/**
 * Draws the cars of the sim's CarPool. Those within CAR_RENDER_RADIUS of the camera render as instanced meshes, one
 * per model part, type and level of detail (paint coloured per instance; update() packs them into the first instance
 * slots); the own car and the ones other players drive are hidden (a DrivenCar draws them). Poses come from
 * pool.poses, which the sim replaces (new object) whenever a car moves.
 */
export class ParkedCars {
  private readonly levels = new Map<CarType, [Level, Level]>();
  /** The car the player drives: not drawn here. */
  private own: number | null = null;
  /** Cars other players drive: not drawn here either (a DrivenCar draws them). */
  private hidden: ReadonlySet<number> = new Set();
  /** Instance slot of each car in its type's meshes, −1 while it is not drawn; and the level it is drawn at. */
  private readonly slots: Int32Array;
  private readonly level: Uint8Array;
  /** Cars with an instance slot, and the pose object last written for each car. */
  private shown: number[] = [];
  private readonly drawn: (CarPose | null)[];
  private lastRebuild: XZ | null = null;
  private readonly m = new Matrix4();
  private readonly base = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly zero = new Vector3(0, 0, 0);
  private readonly dirty = new Set<Level>();

  constructor(scene: Scene, private readonly pool: CarPool, models?: CarModels) {
    const n = pool.count;
    this.slots = new Int32Array(n).fill(-1);
    this.level = new Uint8Array(n);
    this.drawn = new Array<CarPose | null>(n).fill(null);
    for (const [type, m] of models ?? []) {
      const count = Math.max(1, pool.types.filter((t) => t === type).length);
      const make = (model: Object3D, tag: string): Level => {
        const parts = modelParts(model);
        const meshes = parts.map((part, k) => {
          const im = new InstancedMesh(part.geometry, instanceMaterial(part.material), count);
          im.name = `car_${type}_${tag}_${k}`;
          im.count = 0;
          im.castShadow = im.receiveShadow = true;
          scene.add(im);
          return im;
        });
        const paint = parts.map((part) => part.material.name === 'paint');
        meshes.forEach((im, k) => { if (paint[k]) im.setColorAt(0, new Color()); }); // allocate instanceColor
        return { parts, meshes, paint, used: 0 };
      };
      this.levels.set(type, [make(m.full, 'full'), make(m.lod, 'lod')]);
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

  /** Hides the cars other players drive (replaces the previous set; a car that left it is drawn again). */
  setHidden(ids: ReadonlySet<number>): void {
    const old = this.hidden;
    if (old.size === ids.size && [...ids].every((i) => old.has(i))) return;
    this.hidden = new Set(ids);
    for (const c of [...old, ...ids]) this.drawn[c] = null;
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
    if (needsCarRebuild(this.lastRebuild, x, z) || !always.every((i) => this.slots[i]! >= 0 || !this.levels.has(this.pool.types[i]!))) {
      this.rebuild(x, z, always);
    }
    for (const i of this.shown) if (this.pool.poses[i] !== this.drawn[i]) this.writeMatrix(i);
    this.flush();
  }

  private rebuild(x: number, z: number, always: number[]): void {
    this.lastRebuild = { x, z };
    this.shown = visibleCars(this.pool.poses, x, z, CAR_RENDER_RADIUS, always);
    this.slots.fill(-1);
    for (const lv of this.levels.values()) for (const l of lv) l.used = 0;
    const col = new Color();
    for (const i of this.shown) {
      const lv = this.levels.get(this.pool.types[i]!);
      if (!lv) continue;
      const s = this.pool.poses[i]!;
      // the margin keeps cars on the full model until the next rebuild, however the camera moved meanwhile
      const near = Math.hypot(s.x - x, s.z - z) < CAR_LOD_NEAR + CAR_REBUILD_MOVE;
      const l = lv[near ? 0 : 1];
      const k = l.used++;
      this.slots[i] = k;
      this.level[i] = near ? 0 : 1;
      l.meshes.forEach((im, j) => { if (l.paint[j]) im.setColorAt(k, col.setHex(this.pool.colors[i]!)); });
      this.writeMatrix(i);
    }
    for (const lv of this.levels.values()) {
      for (const l of lv) {
        for (const im of l.meshes) {
          im.count = l.used;
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.computeBoundingSphere();
        }
      }
    }
    this.dirty.clear();
  }

  private writeMatrix(i: number): void {
    const k = this.slots[i]!;
    const lv = this.levels.get(this.pool.types[i]!);
    if (k < 0 || !lv) return;
    const l = lv[this.level[i]!]!;
    const s = this.pool.poses[i]!;
    this.drawn[i] = s;
    this.base.compose(this.p.set(s.x, s.y, s.z), this.q.set(s.qx, s.qy, s.qz, s.qw), i === this.own || this.hidden.has(i) ? this.zero : this.one);
    l.meshes.forEach((im, j) => im.setMatrixAt(k, this.m.copy(this.base).multiply(l.parts[j]!.local)));
    this.dirty.add(l);
  }

  private flush(): void {
    for (const l of this.dirty) {
      for (const im of l.meshes) {
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere(); // a pushed car may leave the old bounds (frustum culling)
      }
    }
    this.dirty.clear();
  }
}
