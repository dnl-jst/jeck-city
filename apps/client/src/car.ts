import {
  AdditiveBlending, BoxGeometry, BufferAttribute, type BufferGeometry, CanvasTexture, Color, CylinderGeometry, DoubleSide, Group,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3, type Scene,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TUNING, Vehicle, VEHICLE_REST_Y, type PhysicsWorld, type WorldManifest } from '@nn/shared';

type XZ = { x: number; z: number };
export type CarPose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };

/** Free car (not occupied) nearest to the player within maxDist, by id; null if none. */
export function nearestEnterableCar(player: XZ, cars: { id: number; x: number; z: number; occupied: boolean }[], maxDist = 3): number | null {
  let best: number | null = null;
  let bestD = maxDist;
  for (const c of cars) {
    if (c.occupied) continue;
    const d = Math.hypot(c.x - player.x, c.z - player.z);
    if (d <= bestD) [best, bestD] = [c.id, d];
  }
  return best;
}

/** Getting out is only possible below this speed (m/s). */
export const EXIT_MAX_SPEED = 2;
export const canGetOut = (speed: number): boolean => Math.abs(speed) < EXIT_MAX_SPEED;

/** Lateral distance of the exit spot from the car's centre line (m): 0.6 m clear of the 1.8 m wide body. */
export const EXIT_SIDE = 1.5;
/** Distance of the fallback exit spot behind the car's centre (m): 0.9 m clear of the 4.2 m long body. */
export const EXIT_BEHIND = TUNING.vehicle.length / 2 + 0.9;

/**
 * Where the driver gets out: 1.5 m to the left of the car; if that spot is blocked, to the right;
 * else behind the car. null when all three are blocked. Heading h: forward = (sin h, cos h), left = (cos h, −sin h).
 */
export function exitSpot(car: { x: number; z: number; heading: number }, isFree: (x: number, z: number) => boolean): XZ | null {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  const spots = [
    { x: car.x + c * EXIT_SIDE, z: car.z - s * EXIT_SIDE },
    { x: car.x - c * EXIT_SIDE, z: car.z + s * EXIT_SIDE },
    { x: car.x - s * EXIT_BEHIND, z: car.z - c * EXIT_BEHIND },
  ];
  return spots.find((p) => isFree(p.x, p.z)) ?? null;
}

/** Heading (forward = (sin h, cos h)) of a chassis rotation. */
export function headingOf(q: { qx: number; qy: number; qz: number; qw: number }): number {
  // local +z rotated by q, projected onto x/z
  const fx = 2 * (q.qx * q.qz + q.qw * q.qy);
  const fz = 1 - 2 * (q.qx * q.qx + q.qy * q.qy);
  return Math.atan2(fx, fz);
}

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

/** Soft light pool the headlights throw onto the road (additive decal, faded in at night). */
function beamTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 250, 4, 64, 150, 150);
  grad.addColorStop(0, 'rgba(255,240,210,0.95)');
  grad.addColorStop(0.5, 'rgba(255,230,190,0.35)');
  grad.addColorStop(1, 'rgba(255,220,170,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** The car being driven: a regular mesh group with emissive head- and taillights (× nightFactor) and brake lights. */
export class DrivenCar {
  readonly group = new Group();
  private readonly paint = paintMaterial();
  private readonly headMat = new MeshStandardMaterial({ color: 0xe8e6dc, emissive: 0xfff1d6, roughness: 0.2 });
  private readonly tailMat = new MeshStandardMaterial({ color: 0x7a0e0e, emissive: 0xff1a0a, roughness: 0.3 });
  private readonly beamMat = new MeshBasicMaterial({ map: beamTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });

  constructor(scene: Scene) {
    const g = carGeometries();
    const parts = [new Mesh(g.paint, this.paint), new Mesh(g.trim, trimMaterial()), new Mesh(g.head, this.headMat), new Mesh(g.tail, this.tailMat)];
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; }
    const beam = new Mesh(new PlaneGeometry(4.5, 11).rotateX(-Math.PI / 2).translate(0, G + 0.03, 2.05 + 5.5), this.beamMat);
    beam.renderOrder = 5;
    this.group.add(...parts, beam);
    this.group.visible = false;
    scene.add(this.group);
  }

  show(color: number): void {
    this.paint.color.setHex(color);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  setPose(p: CarPose): void {
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.set(p.qx, p.qy, p.qz, p.qw);
  }

  /** night 0..1; braking lights the tail lamps fully by day too. */
  setLights(night: number, braking: boolean): void {
    this.headMat.emissiveIntensity = 0.15 + 2.2 * night;
    this.tailMat.emissiveIntensity = braking ? 2.5 : 0.08 + 1.1 * night;
    this.beamMat.opacity = 0.55 * night;
    this.beamMat.visible = night > 0.02;
  }
}

// ---------------------------------------------------------------- parked cars

/** Physics bodies exist only for cars this close to the player (m)… */
export const CAR_PHYSICS_NEAR = 150;
/** …and are removed again beyond this distance (hysteresis). */
export const CAR_PHYSICS_FAR = 200;

/**
 * All manifest cars. Unoccupied ones render as two InstancedMeshes (paint coloured per instance, trim);
 * a sleeping Rapier Vehicle exists only near the player. Poses of pushed cars live in `poses`, so a car
 * re-created after being disposed appears where it was left, not at its original spot.
 */
export class ParkedCars {
  readonly poses: CarPose[];
  readonly colors: number[];
  private readonly vehicles = new Map<number, Vehicle>();
  private readonly paint: InstancedMesh;
  private readonly trim: InstancedMesh;
  private occupied: number | null = null;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly zero = new Vector3(0, 0, 0);

  constructor(scene: Scene, private readonly pw: PhysicsWorld, parked: WorldManifest['parked']) {
    this.poses = parked.map((c) => ({ x: c.x, y: VEHICLE_REST_Y, z: c.z, qx: 0, qy: Math.sin(c.heading / 2), qz: 0, qw: Math.cos(c.heading / 2) }));
    this.colors = parked.map((c) => c.color);
    const g = carGeometries();
    this.paint = new InstancedMesh(g.paint, paintMaterial(), parked.length);
    this.trim = new InstancedMesh(merged([g.trim, g.head, g.tail]), trimMaterial(), parked.length);
    const col = new Color();
    for (let i = 0; i < parked.length; i++) {
      this.paint.setColorAt(i, col.setHex(this.colors[i]!));
      this.writeMatrix(i);
    }
    for (const im of [this.paint, this.trim]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      scene.add(im);
    }
  }

  get count(): number {
    return this.poses.length;
  }

  private writeMatrix(i: number): void {
    const s = this.poses[i]!;
    this.m.compose(this.p.set(s.x, s.y, s.z), this.q.set(s.qx, s.qy, s.qz, s.qw), i === this.occupied ? this.zero : this.one);
    this.paint.setMatrixAt(i, this.m);
    this.trim.setMatrixAt(i, this.m);
  }

  private flush(): void {
    this.paint.instanceMatrix.needsUpdate = true;
    this.trim.instanceMatrix.needsUpdate = true;
  }

  /** Creates physics cars within CAR_PHYSICS_NEAR of (x, z) and disposes those beyond CAR_PHYSICS_FAR (keeping their pose). */
  updateProximity(x: number, z: number): void {
    for (let i = 0; i < this.poses.length; i++) {
      const s = this.poses[i]!;
      const d = Math.hypot(s.x - x, s.z - z);
      const v = this.vehicles.get(i);
      if (!v && d <= CAR_PHYSICS_NEAR) this.vehicles.set(i, this.spawn(i));
      else if (v && d > CAR_PHYSICS_FAR && i !== this.occupied) {
        this.poses[i] = v.pose();
        v.dispose();
        this.vehicles.delete(i);
      }
    }
  }

  /** A sleeping Vehicle at the car's stored pose (its original spot or where it was pushed to). */
  private spawn(i: number): Vehicle {
    const s = this.poses[i]!;
    const v = new Vehicle(this.pw, { x: s.x, z: s.z, heading: headingOf(s) });
    if (Math.abs(s.y - VEHICLE_REST_Y) > 1e-4 || Math.abs(s.qx) + Math.abs(s.qz) > 1e-4) {
      v.chassis.setTranslation({ x: s.x, y: s.y, z: s.z }, false);
      v.chassis.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, false);
    }
    return v;
  }

  /** Copies the poses of awake (pushed or driven) cars into the instances. */
  sync(): void {
    let changed = false;
    for (const [i, v] of this.vehicles) {
      if (v.chassis.isSleeping()) continue;
      this.poses[i] = v.pose();
      if (i !== this.occupied) { this.writeMatrix(i); changed = true; }
    }
    if (changed) this.flush();
  }

  /** Cars for nearestEnterableCar. */
  candidates(): { id: number; x: number; z: number; occupied: boolean }[] {
    return this.poses.map((s, id) => ({ id, x: s.x, z: s.z, occupied: id === this.occupied }));
  }

  /** Takes car i: hides its instance and returns its (occupied, awake) Vehicle. */
  enter(i: number): Vehicle {
    let v = this.vehicles.get(i);
    if (!v) this.vehicles.set(i, (v = this.spawn(i)));
    this.occupied = i;
    v.setOccupied(true);
    this.writeMatrix(i);
    this.flush();
    return v;
  }

  /** Leaves the occupied car where it is: parking brake on, instance shown again. */
  exit(): void {
    const i = this.occupied;
    if (i === null) return;
    const v = this.vehicles.get(i)!;
    v.setOccupied(false);
    this.poses[i] = v.pose();
    this.occupied = null;
    this.writeMatrix(i);
    this.flush();
  }

  /** Number of physics cars (debug/tests). */
  physicsCount(): number {
    return this.vehicles.size;
  }
}
