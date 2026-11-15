import { Box3, Group, Mesh, MeshStandardMaterial, Object3D, SpotLight, Vector3, type Material } from 'three';
import type { BikeState, BikeType } from '@nn/shared';

/** Wheel rotation (rad) for a distance rolled (m) on a wheel of `radius` (m). */
export const wheelSpin = (distance: number, radius: number): number => distance / radius;

/** Front lamp: spot light reach and strength at full night. */
const SPOT_DISTANCE = 28;
const SPOT_INTENSITY = 2500;
/** Lamp glass glow at full night (emissive intensity). */
const LAMP_GLOW = 3;

const WHEELS = ['wheel_front', 'wheel_front_l', 'wheel_front_r', 'wheel_rear'];

/**
 * The ridden bike: a clone of a bike model (nodes per data/models/bikes/README.md) under a pose group (position,
 * heading) and a lean group (roll about the forward axis at the ground). update() turns the fork (and `bar`), spins the
 * wheels with the distance ridden, turns the crank with the pedal phase and keeps the pedals level.
 */
export class BikeRig {
  readonly root = new Group();
  readonly leanGroup = new Group();
  /** This rig's own copies of the paint and lamp materials (null if the model has none). */
  paint: MeshStandardMaterial | null = null;
  lampFront: MeshStandardMaterial | null = null;
  lampRear: MeshStandardMaterial | null = null;
  private readonly nodes = new Map<string, Object3D>();
  private readonly radius = new Map<string, number>();
  private spot: SpotLight | null = null;

  constructor(model: Object3D, readonly type: BikeType) {
    this.root.add(this.leanGroup);
    this.leanGroup.add(model);
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (o.name && !this.nodes.has(o.name)) this.nodes.set(o.name, o);
    });
    for (const w of WHEELS) {
      const n = this.nodes.get(w);
      if (n) this.radius.set(w, new Box3().setFromObject(n).getSize(new Vector3()).y / 2 || 0.35);
    }
    // per-rig copies of the materials it changes
    const copies = new Map<Material, MeshStandardMaterial>();
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: Material): Material => {
        if (!(m instanceof MeshStandardMaterial) || !['paint', 'lamp_front', 'lamp_rear'].includes(m.name)) return m;
        let c = copies.get(m);
        if (!c) {
          c = m.clone();
          copies.set(m, c);
          if (m.name === 'paint') this.paint = c;
          else {
            c.emissive.copy(c.color);
            c.emissiveIntensity = 0;
            if (m.name === 'lamp_front') this.lampFront = c;
            else this.lampRear = c;
          }
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    const front = this.nodes.get('light_front');
    if (front) {
      const spot = new SpotLight(0xfff1dc, 0, SPOT_DISTANCE, 0.45, 0.6, 1.6);
      spot.position.set(0, 0, 0.05);
      spot.target.position.set(0, -0.6, 8);
      front.add(spot, spot.target);
      spot.visible = false;
      this.spot = spot;
    }
  }

  /** The node `name` of the model (frame, fork, wheel_front, …), if it has one. */
  node(name: string): Object3D | undefined {
    return this.nodes.get(name);
  }

  /** Places the bike at its state and animates it; dt = seconds since the last call (wheel spin). */
  update(s: BikeState, lean: number, dt: number): void {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.heading;
    this.leanGroup.rotation.z = lean;
    const yaw = -s.steer; // positive steer = right = towards −x
    for (const n of ['fork', 'bar']) {
      const o = this.nodes.get(n);
      if (o) o.rotation.y = yaw;
    }
    for (const [w, r] of this.radius) this.nodes.get(w)!.rotation.x += wheelSpin(s.speed * dt, r);
    const crank = this.nodes.get('crank');
    if (crank) crank.rotation.x = s.crank;
    for (const p of ['pedal_l', 'pedal_r']) {
      const o = this.nodes.get(p);
      if (o) o.rotation.x = -s.crank;
    }
    this.root.updateMatrixWorld(true);
  }

  /** Frame colour of this bike. */
  setColor(hex: number): void {
    this.paint?.color.setHex(hex);
  }

  /** night 0..1: lamps glow, and from dusk on the front lamp lights the road. */
  setLights(night: number): void {
    if (this.lampFront) this.lampFront.emissiveIntensity = night * LAMP_GLOW;
    if (this.lampRear) this.lampRear.emissiveIntensity = night * LAMP_GLOW;
    if (this.spot) {
      this.spot.visible = night > 0.3;
      this.spot.intensity = night * SPOT_INTENSITY;
    }
  }

  /** Position of node `name` in the lean group's frame (where the rider figure hangs while riding). */
  localPoint(name: string): Vector3 {
    this.root.updateMatrixWorld(true);
    return this.leanGroup.worldToLocal(this.world(name));
  }

  /** World position of the saddle point. */
  seat(): Vector3 {
    return this.world('seat');
  }

  /** World positions of the left and right grip. */
  grips(): [Vector3, Vector3] {
    return [this.world('grip_l'), this.world('grip_r')];
  }

  private world(name: string): Vector3 {
    const o = this.nodes.get(name);
    return o ? o.getWorldPosition(new Vector3()) : this.root.position.clone();
  }
}

/** Indices of the bikes within `radius` of (x, z), without `skip` (the ridden one). */
export function visibleBikes(poses: readonly { x: number; z: number }[], x: number, z: number, radius: number, skip: number | null): number[] {
  const out: number[] = [];
  poses.forEach((p, i) => {
    if (i !== skip && (p.x - x) ** 2 + (p.z - z) ** 2 <= radius * radius) out.push(i);
  });
  return out;
}
