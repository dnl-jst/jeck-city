import { Color, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry, type Material, type Mesh, type Object3D, type Scene } from 'three';
import type { BikePose, BikeType, WorldManifest } from '@nn/shared';
import { visibleBikes } from './rig';

/** What the view needs of ParkedBikes (shared). */
export type BikeSource = {
  readonly poses: readonly BikePose[];
  readonly types: readonly BikeType[];
  readonly colors: readonly number[];
  /** Who rides each bike (null: parked); ridden bikes are drawn by their rider's rig, not here. */
  readonly rider: readonly (number | null)[];
  activeIds(): number[];
  /** The side a bike lies on (1 left, −1 right, 0 standing); optional for sources without any. */
  fallSide?(id: number): number;
};

/**
 * A lying bike is rolled onto its side about its forward axis (77°: on the bar end and a pedal or the deck edge, not
 * flat), its left (rider's left, +x in the model) for fall 1, its right for −1, lifted so its lowest point touches the
 * ground (per model and side, see lowest).
 */
const LIE_ANGLE = Math.PI / 2 - 0.23;
/** Falling over takes FALL_S (accelerating like a toppling pole), then it bounces back BOUNCE (rad) once and settles. */
export const FALL_S = 0.45;
const BOUNCE = 0.09;
const SETTLE_S = 0.3;

/** How far over a falling bike is (0 standing … 1 lying), `t` s after it started to fall. */
export function fallFraction(t: number): number {
  if (t < FALL_S) return (t / FALL_S) ** 2;
  const u = t - FALL_S;
  if (u >= SETTLE_S) return 1;
  // one hop off the ground, damped
  return 1 - (BOUNCE / LIE_ANGLE) * Math.abs(Math.sin((u / SETTLE_S) * 2 * Math.PI)) * Math.exp(-u * 8);
}

/** Lowest y of a model's parts rolled by `roll` (rad) about its forward axis (z). */
function lowest(ps: readonly Part[], roll: number): number {
  const m = new Matrix4(), v = new Vector3(), r = new Matrix4().makeRotationZ(roll);
  let min = Infinity;
  for (const part of ps) {
    m.multiplyMatrices(r, part.local);
    const pos = part.geometry.getAttribute('position');
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) min = Math.min(min, v.fromBufferAttribute(pos, i).applyMatrix4(m).y);
  }
  return Number.isFinite(min) ? min : 0;
}

/** Rack hoops are drawn within this distance of the camera (m): the city has thousands (millions of triangles). */
export const RACK_RENDER_RADIUS = 150;
/** Parked bikes are drawn within this distance of the camera (m)… */
export const BIKE_RENDER_RADIUS = 120;
/** …the set rebuilt after the camera moved this far (m). */
export const BIKE_REBUILD_MOVE = 15;

type Part = { name: string; geometry: BufferGeometry; material: Material; local: Matrix4 };

/** Every mesh of a model with its matrix relative to the model root (one instanced mesh each). */
function parts(model: Object3D): Part[] {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const out: Part[] = [];
  model.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    for (const mat of [m.material].flat()) out.push({ name: m.name || m.parent?.name || 'part', geometry: m.geometry, material: mat, local: inv.clone().multiply(m.matrixWorld) });
  });
  return out;
}

/** Paint is white in the instanced copy: instanceColor carries each bike's frame colour. */
function instanceMaterial(m: Material): Material {
  if (!(m instanceof MeshStandardMaterial) || m.name !== 'paint') return m;
  const c = m.clone();
  c.color.set(0xffffff);
  return c;
}

/**
 * Parked bikes and rack hoops as instanced meshes: one per model part and type. Bikes within BIKE_RENDER_RADIUS of the
 * camera, without the ridden ones; bikes with a physics body (pushed around) are re-placed every update. Racks within
 * RACK_RENDER_RADIUS, rebuilt with the bikes.
 */
export class BikeView {
  private readonly byType = new Map<BikeType, { parts: Part[]; meshes: InstancedMesh[]; paint: boolean[]; lift: { left: number; right: number } }>();
  /** Instance slot of each bike in its type's meshes, −1 while not drawn. */
  private readonly slots: Int32Array;
  private last: { x: number; z: number } | null = null;
  /** The ridden set at the last rebuild ('1,7': ids). */
  private lastRidden = '';
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly up = new Vector3(0, 1, 0);
  private readonly fwd = new Vector3(0, 0, 1);
  private readonly qr = new Quaternion();
  private readonly rackMeshes: { im: InstancedMesh; list: { x: number; z: number; m: Matrix4 }[] }[] = [];
  /** The side each bike was last drawn lying on (as fallSide), 2 before it was first drawn: a change starts a fall. */
  private readonly shownFall: Int8Array;
  /** Bikes falling over now → seconds since they started. */
  private readonly falling = new Map<number, number>();
  /** Bikes that started to fall in this update (see update). */
  private fell: { x: number; z: number }[] = [];

  constructor(
    scene: Scene, models: ReadonlyMap<BikeType, Object3D>, racks: ReadonlyMap<0 | 1, Object3D>, private readonly src: BikeSource,
    rackList: WorldManifest['bikeRacks'], rackYs: readonly number[],
  ) {
    this.slots = new Int32Array(src.poses.length).fill(-1);
    this.shownFall = new Int8Array(src.poses.length).fill(2);
    for (const [type, model] of models) {
      const ps = parts(model);
      const n = src.types.filter((t) => t === type).length;
      const meshes = ps.map((part) => {
        const im = new InstancedMesh(part.geometry, instanceMaterial(part.material), Math.max(1, n));
        im.name = `bike_${type}_${part.name}`;
        im.count = 0;
        im.castShadow = im.receiveShadow = true;
        scene.add(im);
        return im;
      });
      const paint = ps.map((part) => part.material.name === 'paint');
      meshes.forEach((im, k) => { if (paint[k]) im.setColorAt(0, new Color()); });
      const lift = { left: Math.max(0, -lowest(ps, -LIE_ANGLE)), right: Math.max(0, -lowest(ps, LIE_ANGLE)) };
      this.byType.set(type, { parts: ps, meshes, paint, lift });
    }
    for (const [kind, model] of racks) {
      const list = rackList.map((r, i) => ({ r, y: rackYs[i]! })).filter(({ r }) => r.kind === kind);
      for (const part of parts(model)) {
        const im = new InstancedMesh(part.geometry, part.material, Math.max(1, list.length));
        im.name = `rack_${kind}_${part.name}`;
        im.count = 0;
        im.castShadow = im.receiveShadow = true;
        const placed = list.map(({ r, y }) => ({
          x: r.x, z: r.z, m: new Matrix4().compose(this.p.set(r.x, y, r.z), this.q.setFromAxisAngle(this.up, r.heading), this.one).multiply(part.local),
        }));
        this.rackMeshes.push({ im, list: placed });
        scene.add(im);
      }
    }
  }

  /**
   * Rebuilds the drawn set when the camera moved or the ridden bikes changed; re-places bikes that have a body and
   * those falling over (dt: seconds since the last update). Returns where drawn bikes started to fall over.
   */
  update(camX: number, camZ: number, dt = 0): { x: number; z: number }[] {
    this.fell = [];
    for (const [i, t] of this.falling) {
      if (t >= FALL_S + SETTLE_S) this.falling.delete(i);
      else this.falling.set(i, t + dt);
    }
    const ridden = new Set<number>();
    this.src.rider.forEach((r, i) => { if (r !== null) ridden.add(i); });
    const key = [...ridden].join();
    const moved = !this.last || Math.hypot(camX - this.last.x, camZ - this.last.z) > BIKE_REBUILD_MOVE;
    if (moved || key !== this.lastRidden) {
      this.last = { x: camX, z: camZ };
      this.lastRidden = key;
      this.rebuild(camX, camZ, ridden);
    } else {
      const touched = new Set<BikeType>();
      for (const i of new Set([...this.src.activeIds(), ...this.falling.keys()])) {
        if (this.slots[i]! < 0) continue;
        this.write(i);
        touched.add(this.src.types[i]!);
      }
      for (const t of touched) for (const im of this.byType.get(t)!.meshes) im.instanceMatrix.needsUpdate = true;
    }
    return this.fell;
  }

  private rebuild(x: number, z: number, ridden: ReadonlySet<number>): void {
    const r2 = RACK_RENDER_RADIUS * RACK_RENDER_RADIUS;
    for (const { im, list } of this.rackMeshes) {
      let k = 0;
      for (const r of list) if ((r.x - x) ** 2 + (r.z - z) ** 2 <= r2) im.setMatrixAt(k++, r.m);
      im.count = k;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
    // (a bike not drawn until now shows its fall as it is: it fell, if at all, out of sight)
    const before = this.slots.slice();
    this.slots.fill(-1);
    const shown = visibleBikes(this.src.poses, x, z, BIKE_RENDER_RADIUS, ridden);
    const next = new Map<BikeType, number>();
    const col = new Color();
    for (const i of shown) {
      const t = this.src.types[i]!;
      const e = this.byType.get(t);
      if (!e) continue;
      const k = next.get(t) ?? 0;
      next.set(t, k + 1);
      this.slots[i] = k;
      if (before[i]! < 0) this.shownFall[i] = 2;
      e.meshes.forEach((im, j) => { if (e.paint[j]) im.setColorAt(k, col.setHex(this.src.colors[i]!)); });
      this.write(i);
    }
    for (const [t, e] of this.byType) {
      for (const im of e.meshes) {
        im.count = next.get(t) ?? 0;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
      }
    }
  }

  private write(i: number): void {
    const k = this.slots[i]!;
    const e = this.byType.get(this.src.types[i]!);
    if (k < 0 || !e) return;
    const s = this.src.poses[i]!;
    const side = Math.sign(this.src.fallSide?.(i) ?? 0);
    // a bike lying since it was first drawn just lies; one that falls (or is set down) while drawn falls over
    const shown = this.shownFall[i]!;
    if (shown !== side) {
      this.shownFall[i] = side;
      this.falling.delete(i);
      if (shown !== 2 && side !== 0) {
        this.falling.set(i, 0);
        this.fell.push({ x: s.x, z: s.z });
      }
    }
    this.q.setFromAxisAngle(this.up, s.heading);
    let lift = 0;
    if (side !== 0) {
      const t = this.falling.get(i);
      const f = t === undefined ? 1 : fallFraction(t);
      this.q.multiply(this.qr.setFromAxisAngle(this.fwd, -side * LIE_ANGLE * f));
      // (the lowest point only reaches below the ground in the last part of the fall)
      lift = (side > 0 ? e.lift.left : e.lift.right) * f ** 4;
    }
    const base = new Matrix4().compose(this.p.set(s.x, s.y + lift, s.z), this.q, this.one);
    e.meshes.forEach((im, j) => im.setMatrixAt(k, this.m.copy(base).multiply(e.parts[j]!.local)));
  }
}
