import { Box3, Color, Group, Mesh, MeshStandardMaterial, Object3D, SpotLight, Vector3, type Material } from 'three';
import type { BikeState, BikeType } from '@nn/shared';
import type { Posture } from '../player';
import { spreadIndices } from '../quality';

/** Upper-body posture of a rider per bike type. */
export const RIDER_POSTURE: Record<BikeType, Posture> = { dutch: 'upright', road: 'race', mtb: 'sport', longjohn: 'upright', trike: 'upright', soundjohn: 'upright' };

const DISCO_HUE = new Color();

/** Wheel rotation (rad) for a distance rolled (m) on a wheel of `radius` (m). */
export const wheelSpin = (distance: number, radius: number): number => distance / radius;

/** Front lamp: spot light reach and strength at full night. */
const SPOT_DISTANCE = 28;
const SPOT_INTENSITY = 2500;
/** Lamp glass glow at full night (emissive intensity). */
const LAMP_GLOW = 3;

const WHEELS = ['wheel_front', 'wheel_front_l', 'wheel_front_r', 'wheel_rear'];
/** The shown lean follows the physics lean with this time constant (s): the bike tips in and out softly. */
const LEAN_TAU = 0.22;
/** The shown pitch and height on uneven ground follow the wheel probes with this time constant (s): kerbs roll in. */
const PITCH_TAU = 0.06;

/** Disco ball (node `disco`, sound Long John): spin (rad/s), mirror shimmer and its light dots. */
const DISCO_SPIN = 1.3;
const DISCO_GLOW = 0.9;
const DISCO_COLORS = [0xff2d6f, 0x2de1ff, 0xfff04a, 0x7cff4a, 0xb04aff, 0xff8a2d, 0x2d6fff, 0xff4ae0];
/** Spots per colour: narrow beams fanned round the ball, mostly down onto the street and the house walls. */
const DISCO_ELEVATION = [-0.75, -0.4, -0.15, 0.1];
const DISCO_DOT = { angle: 0.06, penumbra: 0.35, distance: 22, decay: 1.6, intensity: 1500 };

/**
 * The ridden bike: a clone of a bike model (nodes per data/models/bikes/README.md) under a pose group (position,
 * heading) and a lean group (roll about the forward axis at the ground). update() turns the fork (and `bar`), spins the
 * wheels with the distance ridden, turns the crank with the pedal phase and keeps the pedals level.
 */
export class BikeRig {
  readonly root = new Group();
  readonly leanGroup = new Group();
  /** Between root and lean group: pitch about the sideways axis and height so both wheels sit on uneven ground. */
  private readonly pitchGroup = new Group();
  /** This rig's own copies of the paint and lamp materials (null if the model has none). */
  paint: MeshStandardMaterial | null = null;
  lampFront: MeshStandardMaterial | null = null;
  lampRear: MeshStandardMaterial | null = null;
  private readonly nodes = new Map<string, Object3D>();
  private readonly radius = new Map<string, number>();
  private lights: BikeLights | null = null;
  private disco: Object3D | null = null;
  private discoMirror: MeshStandardMaterial | null = null;
  private discoT = 0;
  /** Disco ball spinning with its light dots (only bikes with a `disco` node). */
  discoOn = false;
  private lean = 0;
  private pitch = 0;
  private dy = 0;
  private snap = false;

  constructor(model: Object3D, readonly type: BikeType) {
    this.root.add(this.pitchGroup);
    this.pitchGroup.add(this.leanGroup);
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
        if (!(m instanceof MeshStandardMaterial) || !['paint', 'lamp_front', 'lamp_rear', 'mirror'].includes(m.name)) return m;
        let c = copies.get(m);
        if (!c) {
          c = m.clone();
          copies.set(m, c);
          if (m.name === 'paint') this.paint = c;
          else if (m.name === 'mirror') {
            c.emissiveIntensity = 0;
            this.discoMirror = c;
          }
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
    this.disco = this.nodes.get('disco') ?? null;
  }

  /**
   * Borrows the scene's bike lights while ridden: the front spot moves to `light_front`, the dots to `disco`. Call after
   * adding root to the scene (and detachLights before removing it), so the scene's light count never changes.
   */
  attachLights(lights: BikeLights): void {
    this.lights = lights;
    const front = this.nodes.get('light_front');
    if (front) front.add(lights.front, lights.front.target);
    if (this.disco) for (const s of lights.dots) this.disco.add(s, s.target);
  }

  /** Hands the lights back to their holder, dark. */
  detachLights(): void {
    this.setLights(0);
    this.setDisco(false);
    this.lights?.park();
    this.lights = null;
  }

  /** Whether this bike carries a disco ball. */
  get hasDisco(): boolean {
    return this.disco !== null;
  }

  /** Disco ball on (spins, shimmers, throws coloured dots) or off. */
  setDisco(on: boolean): void {
    this.discoOn = on && this.hasDisco;
    if (this.lights) for (const s of this.lights.dots) s.intensity = this.discoOn ? DISCO_DOT.intensity : 0;
    if (this.discoMirror) this.discoMirror.emissiveIntensity = this.discoOn ? DISCO_GLOW : 0;
  }

  /** Shows the target lean at once on the next update (getting on, tests). */
  snapLean(): void {
    this.snap = true;
  }

  /** The node `name` of the model (frame, fork, wheel_front, …), if it has one. */
  node(name: string): Object3D | undefined {
    return this.nodes.get(name);
  }

  /** Places the bike at its state and animates it; dt = seconds since the last call (wheel spin, lean easing). */
  update(s: BikeState, lean: number, dt: number, ground: { pitch: number; dy: number } = { pitch: 0, dy: 0 }): void {
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.heading;
    this.lean = this.snap ? lean : this.lean + (lean - this.lean) * (1 - Math.exp(-dt / LEAN_TAU));
    const kp = this.snap ? 1 : 1 - Math.exp(-dt / PITCH_TAU);
    this.pitch += (ground.pitch - this.pitch) * kp;
    this.dy += (ground.dy - this.dy) * kp;
    this.snap = false;
    // nose up = the forward axis (+z) turns towards +y = a negative rotation about +x
    this.pitchGroup.rotation.x = -this.pitch;
    this.pitchGroup.position.y = this.dy;
    this.leanGroup.rotation.z = this.lean;
    const yaw = -s.steer; // positive steer = right = towards −x
    for (const n of ['fork', 'bar']) {
      const o = this.nodes.get(n);
      if (o) o.rotation.y = yaw;
    }
    for (const [w, r] of this.radius) this.nodes.get(w)!.rotation.x += wheelSpin(s.speed * dt, r);
    if (this.discoOn && this.disco) {
      this.discoT += dt;
      this.disco.rotation.y += DISCO_SPIN * dt;
      this.discoMirror?.emissive.copy(DISCO_HUE.setHSL((this.discoT * 0.25) % 1, 0.9, 0.5));
    }
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
    if (this.lights) this.lights.front.intensity = night > 0.3 ? night * SPOT_INTENSITY : 0;
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

/**
 * The ridden bike's real lights (front lamp spot, disco ball dots): created once, always in the scene and always
 * visible, only dimmed to zero when unused. three.js recompiles every material in the scene when the number of
 * lights changes, which froze the client for seconds on getting on a bike at night or switching the disco ball.
 */
export class BikeLights {
  readonly front: SpotLight;
  readonly dots: SpotLight[] = [];
  private readonly holder = new Group();

  constructor(scene: Object3D) {
    this.front = new SpotLight(0xfff1dc, 0, SPOT_DISTANCE, 0.45, 0.6, 1.6);
    this.front.position.set(0, 0, 0.05);
    this.front.target.position.set(0, -0.6, 8);
    DISCO_COLORS.forEach((col, k) => {
      const az = (2 * Math.PI * k) / DISCO_COLORS.length;
      const el = DISCO_ELEVATION[k % DISCO_ELEVATION.length]!;
      const d = DISCO_DOT;
      const s = new SpotLight(col, 0, d.distance, d.angle, d.penumbra, d.decay);
      s.target.position.set(Math.cos(az) * Math.cos(el) * 5, Math.sin(el) * 5, Math.sin(az) * Math.cos(el) * 5);
      this.dots.push(s);
    });
    this.holder.name = 'bike-lights';
    scene.add(this.holder);
    this.park();
  }

  /**
   * Keeps only n disco dots (spread evenly round the ball); the others are hidden, so they cost nothing in the shaders.
   * Changing n recompiles the scene's materials: only at startup and when the player switches the quality level.
   */
  setDiscoDots(n: number): void {
    const keep = spreadIndices(this.dots.length, n);
    this.dots.forEach((s, k) => { s.visible = keep.has(k); });
  }

  /** Back into the holder, dark (nobody riding). */
  park(): void {
    for (const l of [this.front, ...this.dots]) {
      l.intensity = 0;
      this.holder.add(l, l.target);
    }
  }
}

/** Indices of the bikes within `radius` of (x, z), without those in `skip` (the ridden ones). */
export function visibleBikes(poses: readonly { x: number; z: number }[], x: number, z: number, radius: number, skip: ReadonlySet<number>): number[] {
  const out: number[] = [];
  poses.forEach((p, i) => {
    if (!skip.has(i) && (p.x - x) ** 2 + (p.z - z) ** 2 <= radius * radius) out.push(i);
  });
  return out;
}
