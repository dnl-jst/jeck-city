import type { Camera, Object3D, Scene } from 'three';
import {
  BIKE_GEAR, BIKE_SPECS, BIKE_WHEEL_RADIUS, bikeLean, SUSPENSION_REST_LENGTH, VEHICLE_REST_Y, type BikeState, type BikeType, type CarPose, type CarType, type SnapshotCar,
  type SnapshotRider, type SnapshotWalker, type StationId,
} from '@nn/shared';
import { BikeRig, RIDER_POSTURE } from '../bikes/rig';
import { DrivenCar, lampPower, type CarModels, type WheelSource } from '../car';
import { PlayerFigure } from '../player';
import { LABEL_GAP, NameLabel, type Label } from './name-label';

/** Figure height (m) the label floats above. */
const FIGURE_H = 1.8;
/** A rider's head above the ground (m; seated a little higher than standing). */
const RIDER_H = 1.9;
/** Crank angle (rad) per metre ridden, as the sim's bike. */
const CRANK_PER_M = 1 / (BIKE_WHEEL_RADIUS * BIKE_GEAR);
/** Roof of a car above the road (m). */
const ROOF_H = 1.5;
/** A walker that moved further than this in one frame was teleported: no running animation for it. */
const JUMP_M = 3;

type Vec3 = { x: number; y: number; z: number };

/** The part of ParkedCars this uses. */
export interface ParkedHider {
  setHidden(ids: ReadonlySet<number>): void;
}

/** The parts of DrivenCar this uses (tests replace it, DrivenCar builds canvas textures). */
export interface CarView {
  show(type: CarType, color: number): void;
  hide(): void;
  setPose(p: CarPose): void;
  setWheels(w: WheelSource, dt: number): void;
  setLights(night: number, braking: boolean, power: number): void;
  updateGlare(camera: Camera, occluded: (from: Vec3, to: Vec3) => boolean, dt: number): void;
}

/** What the slow state says about a car: who drives (slot) and the lamp level (0 off, 0.5 cranking, 1 on). */
export type RemoteCarInfo = {
  driver: number; level: 0 | 0.5 | 1;
  /** Ignition state and the radio station of the car (sound only; absent: off, none). */
  engine?: 'off' | 'starting' | 'running'; radio?: StationId | null;
};

export type RemoteSampleIn = {
  walkers: ReadonlyMap<string, SnapshotWalker>; cars: ReadonlyMap<string, SnapshotCar>; riders?: ReadonlyMap<string, SnapshotRider>;
};

/** The parts of BikeRig this uses (tests replace it, BikeRig clones a model). */
export type RiderRig = Pick<BikeRig, 'root' | 'leanGroup' | 'type' | 'update' | 'setColor' | 'setLights' | 'localPoint'>;

export type RemoteOptions = {
  /** The own slot: never drawn, never labelled. */
  me: number;
  colorOf(car: number): number;
  typeOf(car: number): CarType;
  /** Car model templates (as for the own car); without them remote cars are unseen, as parked ones are. */
  carModels?: CarModels;
  /** Character model template for other players' figures (null/absent: the primitive stand-in). */
  figureModel?: Object3D | null;
  /**
   * The character model of variant v (index into CHARACTER_VARIANTS) if it is loaded (loading it otherwise), else
   * null; wins over figureModel.
   */
  figureFor?: (variant: number) => Object3D | null;
  /** Bike model templates per type; without one a rider is a figure without a bike. */
  bikeModels?: ReadonlyMap<BikeType, Object3D>;
  bikeTypeOf?(bike: number): BikeType;
  bikeColorOf?(bike: number): number;
  /** Pitch and height so a remote bike's wheels sit on uneven ground (absent: shown level). */
  bikeGroundPose?(type: BikeType, s: BikeState): { pitch: number; dy: number };
  makeRig?: (type: BikeType) => RiderRig | null;
  occluded(from: Vec3, to: Vec3): boolean;
  makeLabel?: (name: string) => Label;
  makeCar?: () => CarView;
};

/** A pooled figure and the character template it shows (undefined: not set yet). */
type Figure = { fig: PlayerFigure; model: Object3D | null | undefined };
type Walker = Figure & { label: Label | null; px: number; pz: number; vx: number; vz: number; seen: boolean; fresh: boolean; state: number };
type Rider = Figure & { label: Label | null; rig: RiderRig | null; crank: number; seen: boolean };
type Driven = { view: CarView; label: Label | null; seen: boolean };

/**
 * Other players: figures on foot (pooled; a figure is hidden when its player leaves and reused for the next), each
 * with the player's own character variant; riders as their figure seated on a rig of their bike's model (main's
 * riding pose and IK; the parked instance is hidden by BikeView through the sim's riders); driven cars as
 * DrivenCar({ beams: false }) with the parked instance hidden; a name label over each. Unoccupied cars and bikes need
 * nothing here (the sim follows the stream; ParkedCars / BikeView draw them).
 */
export class RemotePlayers {
  private readonly walkers = new Map<number, Walker>();
  private readonly riders = new Map<number, Rider>();
  private readonly freeFigures: Figure[] = [];
  private readonly freeRigs = new Map<BikeType, RiderRig[]>();
  private readonly driven = new Map<number, Driven>();
  private readonly freeCars: CarView[] = [];
  private readonly hiding = new Set<number>();

  constructor(private readonly scene: Scene, private readonly parked: ParkedHider, private readonly opts: RemoteOptions) {}

  /**
   * One frame. `names`: slot → name (slow state); `cars`: car → driver slot and lamp level (slow state); night 0..1;
   * `variants`: slot → character variant (slow state; missing = the first). Players in a car or on a bike are not in
   * the walker sample (the car or the rider entry stands for them).
   */
  update(
    sample: RemoteSampleIn, names: ReadonlyMap<number, string>, cars: ReadonlyMap<number, RemoteCarInfo>, camera: Camera, night: number, dt: number,
    variants: ReadonlyMap<number, number> = new Map(),
  ): void {
    const cp = camera.position;
    for (const w of this.walkers.values()) w.seen = false;
    for (const s of sample.walkers.values()) {
      if (s.slot === this.opts.me) continue;
      let w = this.walkers.get(s.slot);
      if (!w) {
        const f = this.takeFigure();
        f.fig.heading = s.yaw;
        w = { ...f, label: null, px: s.x, pz: s.z, vx: 0, vz: 0, seen: true, fresh: true, state: -1 };
        this.walkers.set(s.slot, w);
      }
      w.seen = true;
      this.dress(w, variants.get(s.slot) ?? 0);
      // fell off a bike: tips over, lies, gets up (the figure times it itself)
      if (s.state === 3 && w.state !== 3) w.fig.fall(s.yaw);
      w.state = s.state;
      let vx = 0, vz = 0;
      if (!w.fresh && dt > 1e-4) {
        const dx = s.x - w.px, dz = s.z - w.pz;
        if (Math.hypot(dx, dz) < JUMP_M) { vx = dx / dt; vz = dz / dt; }
      }
      w.fresh = false;
      // smoothed: the interpolated stream moves in 20 Hz-shaped steps
      const k = Math.min(1, dt * 12);
      w.vx += (vx - w.vx) * k;
      w.vz += (vz - w.vz) * k;
      w.px = s.x; w.pz = s.z;
      w.fig.setDown(s.state === 2 ? 1 : 0);
      w.fig.update(s.x, s.y, s.z, { x: w.vx, y: 0, z: w.vz }, dt);
      w.label = this.label(w.label, names.get(s.slot), s.x, s.y + FIGURE_H + LABEL_GAP, s.z, cp);
    }
    for (const [slot, w] of this.walkers) {
      if (w.seen) continue;
      w.label?.dispose();
      this.freeFigure(w);
      this.walkers.delete(slot);
    }

    for (const r of this.riders.values()) r.seen = false;
    for (const s of sample.riders?.values() ?? []) {
      if (s.slot === this.opts.me) continue;
      const type = this.opts.bikeTypeOf?.(s.bikeId) ?? 'dutch';
      let r = this.riders.get(s.slot);
      if (r && r.rig?.type !== type) {
        this.freeRig(r);
        r.rig = this.takeRig(type);
      }
      if (!r) {
        r = { ...this.takeFigure(), label: null, rig: this.takeRig(type), crank: 0, seen: true };
        this.riders.set(s.slot, r);
      }
      r.seen = true;
      this.dress(r, variants.get(s.slot) ?? 0);
      if (s.pedalling && s.speed > 0) r.crank += s.speed * CRANK_PER_M * dt;
      const st: BikeState = { x: s.x, y: s.y, z: s.z, heading: s.heading, speed: s.speed, steer: s.steer, vy: 0, grounded: !s.airborne, crank: r.crank };
      const rig = r.rig;
      if (rig) {
        rig.setColor(this.opts.bikeColorOf?.(s.bikeId) ?? 0xffffff);
        rig.update(st, bikeLean(BIKE_SPECS[type], s.speed, s.steer), dt, this.opts.bikeGroundPose?.(type, st));
        rig.setLights(night);
        if (r.fig.group.parent !== rig.leanGroup) rig.leanGroup.add(r.fig.group);
        r.fig.ride(rig.localPoint('seat'), [rig.localPoint('grip_l'), rig.localPoint('grip_r')],
          [rig.localPoint('pedal_l'), rig.localPoint('pedal_r')], RIDER_POSTURE[type]);
      } else {
        // no bike model: the figure glides along where the bike is
        r.fig.update(s.x, s.y, s.z, { x: Math.sin(s.heading) * s.speed, y: 0, z: Math.cos(s.heading) * s.speed }, dt);
      }
      r.label = this.label(r.label, names.get(s.slot), s.x, s.y + RIDER_H + LABEL_GAP, s.z, cp);
    }
    for (const [slot, r] of this.riders) {
      if (r.seen) continue;
      r.label?.dispose();
      this.freeRig(r);
      this.freeFigure(r);
      this.riders.delete(slot);
    }

    this.hiding.clear();
    for (const d of this.driven.values()) d.seen = false;
    for (const c of sample.cars.values()) {
      const info = cars.get(c.id);
      if (!c.hasDriver || !info || info.driver === this.opts.me) continue;
      this.hiding.add(c.id);
      let d = this.driven.get(c.id);
      if (!d) {
        const view = this.freeCars.pop() ?? this.opts.makeCar?.() ?? new DrivenCar(this.scene, this.opts.carModels, { beams: false });
        view.show(this.opts.typeOf(c.id), this.opts.colorOf(c.id));
        d = { view, label: null, seen: true };
        this.driven.set(c.id, d);
      }
      d.seen = true;
      d.view.setPose(c);
      d.view.setWheels(streamedWheels(c), dt);
      // lamp level from the slow state (the flicker while cranking is local), brake light from the snapshot
      d.view.setLights(night, c.brakeLight, lampPower(info.level, Math.random));
      d.view.updateGlare(camera, this.opts.occluded, dt);
      d.label = this.label(d.label, names.get(info.driver), c.x, c.y - VEHICLE_REST_Y + ROOF_H + LABEL_GAP, c.z, cp);
    }
    for (const [id, d] of this.driven) {
      if (d.seen) continue;
      d.view.hide();
      d.label?.dispose();
      this.freeCars.push(d.view);
      this.driven.delete(id);
    }
    this.parked.setHidden(this.hiding);
  }

  /** A figure from the pool (or a new one), visible in the scene. */
  private takeFigure(): Figure {
    const f = this.freeFigures.pop() ?? { fig: new PlayerFigure(this.scene), model: undefined };
    f.fig.visible = true;
    return { fig: f.fig, model: f.model };
  }

  /** Back into the pool: hidden, standing, in the scene again (off a rig). */
  private freeFigure(f: Figure): void {
    f.fig.visible = false;
    f.fig.reset();
    if (f.fig.group.parent !== this.scene) this.scene.add(f.fig.group);
    this.freeFigures.push({ fig: f.fig, model: f.model });
  }

  /** Shows the player's character variant (once its model is loaded; until then the default figure). */
  private dress(f: Figure, variant: number): void {
    const model = this.opts.figureFor?.(variant) ?? this.opts.figureModel ?? null;
    if (f.model === model) return;
    f.fig.setModel(model);
    f.model = model;
  }

  /** A rig of `type` from the pool (or a new one), in the scene; null without a model of that type. */
  private takeRig(type: BikeType): RiderRig | null {
    let rig = this.freeRigs.get(type)?.pop() ?? null;
    if (!rig) {
      const model = this.opts.bikeModels?.get(type);
      rig = this.opts.makeRig?.(type) ?? (model ? new BikeRig(model.clone(true), type) : null);
    }
    if (rig) this.scene.add(rig.root);
    return rig;
  }

  /** The rider's rig back into the pool (its figure goes back into the scene). */
  private freeRig(r: Rider): void {
    const rig = r.rig;
    if (!rig) return;
    this.scene.add(r.fig.group);
    this.scene.remove(rig.root);
    rig.setLights(0);
    const list = this.freeRigs.get(rig.type) ?? [];
    list.push(rig);
    this.freeRigs.set(rig.type, list);
    r.rig = null;
  }

  /** The label for `name` placed at (x, y, z): created or renamed as needed, dropped while no name is known. */
  private label(cur: Label | null, name: string | undefined, x: number, y: number, z: number, cam: Vec3): Label | null {
    if (name === undefined || name === '') {
      cur?.dispose();
      return null;
    }
    if (cur && cur.name !== name) {
      cur.dispose();
      cur = null;
    }
    if (!cur) {
      cur = this.opts.makeLabel?.(name) ?? new NameLabel(name);
      cur.attach(this.scene);
    }
    cur.place(x, y, z, Math.hypot(x - cam.x, y - cam.y, z - cam.z));
    return cur;
  }

  /** Frees the labels' textures and shows every parked car again. */
  dispose(): void {
    for (const w of this.walkers.values()) w.label?.dispose();
    for (const r of this.riders.values()) r.label?.dispose();
    for (const d of this.driven.values()) d.label?.dispose();
    this.walkers.clear();
    this.riders.clear();
    this.driven.clear();

    this.parked.setHidden(new Set());
  }
}

/** Wheels of a streamed car: spin with its speed along the heading and steer as sent; suspension at rest. */
function streamedWheels(c: SnapshotCar): WheelSource {
  // forward = local +z rotated by the chassis quaternion
  const fx = 2 * (c.qx * c.qz + c.qw * c.qy), fz = 1 - 2 * (c.qx * c.qx + c.qy * c.qy);
  const speed = c.vx * fx + c.vz * fz;
  return { speed: () => speed, wheelSteering: () => c.steer, wheelSuspension: () => SUSPENSION_REST_LENGTH };
}
