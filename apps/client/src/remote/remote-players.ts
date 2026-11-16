import type { Camera, Scene } from 'three';
import { VEHICLE_REST_Y, type CarPose, type SnapshotCar, type SnapshotWalker } from '@nn/shared';
import { DrivenCar, lampPower } from '../car';
import { PlayerFigure } from '../player';
import { LABEL_GAP, NameLabel, type Label } from './name-label';

/** Figure height (m) the label floats above. */
const FIGURE_H = 1.8;
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
  show(color: number): void;
  hide(): void;
  setPose(p: CarPose): void;
  setLights(night: number, braking: boolean, power: number): void;
  updateGlare(camera: Camera, occluded: (from: Vec3, to: Vec3) => boolean, dt: number): void;
}

/** What the slow state says about a car: who drives (slot) and the lamp level (0 off, 0.5 cranking, 1 on). */
export type RemoteCarInfo = { driver: number; level: 0 | 0.5 | 1 };

export type RemoteSampleIn = { walkers: ReadonlyMap<string, SnapshotWalker>; cars: ReadonlyMap<string, SnapshotCar> };

export type RemoteOptions = {
  /** The own slot: never drawn, never labelled. */
  me: number;
  colorOf(car: number): number;
  occluded(from: Vec3, to: Vec3): boolean;
  makeLabel?: (name: string) => Label;
  makeCar?: () => CarView;
};

type Walker = { fig: PlayerFigure; label: Label | null; px: number; pz: number; vx: number; vz: number; seen: boolean; fresh: boolean };
type Driven = { view: CarView; label: Label | null; seen: boolean };

/**
 * Other players: figures on foot (pooled; a figure is hidden when its player leaves and reused for the next), driven
 * cars as DrivenCar({ beams: false }) with the parked instance hidden, and a name label over each. Unoccupied cars
 * need nothing here (the sim's car pool follows the stream; ParkedCars draws it).
 */
export class RemotePlayers {
  private readonly walkers = new Map<number, Walker>();
  private readonly freeFigures: PlayerFigure[] = [];
  private readonly driven = new Map<number, Driven>();
  private readonly freeCars: CarView[] = [];
  private readonly hiding = new Set<number>();

  constructor(private readonly scene: Scene, private readonly parked: ParkedHider, private readonly opts: RemoteOptions) {}

  /**
   * One frame. `names`: slot → name (slow state); `cars`: car → driver slot and lamp level (slow state); night 0..1.
   * Players in a car are not in the walker sample (the car stands for them).
   */
  update(sample: RemoteSampleIn, names: ReadonlyMap<number, string>, cars: ReadonlyMap<number, RemoteCarInfo>, camera: Camera, night: number, dt: number): void {
    const cp = camera.position;
    for (const w of this.walkers.values()) w.seen = false;
    for (const s of sample.walkers.values()) {
      if (s.slot === this.opts.me) continue;
      let w = this.walkers.get(s.slot);
      if (!w) {
        const fig = this.freeFigures.pop() ?? new PlayerFigure(this.scene);
        fig.visible = true;
        fig.heading = s.yaw;
        w = { fig, label: null, px: s.x, pz: s.z, vx: 0, vz: 0, seen: true, fresh: true };
        this.walkers.set(s.slot, w);
      }
      w.seen = true;
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
      w.fig.visible = false;
      w.fig.setDown(0);
      w.label?.dispose();
      this.freeFigures.push(w.fig);
      this.walkers.delete(slot);
    }

    this.hiding.clear();
    for (const d of this.driven.values()) d.seen = false;
    for (const c of sample.cars.values()) {
      const info = cars.get(c.id);
      if (!c.hasDriver || !info || info.driver === this.opts.me) continue;
      this.hiding.add(c.id);
      let d = this.driven.get(c.id);
      if (!d) {
        const view = this.freeCars.pop() ?? this.opts.makeCar?.() ?? new DrivenCar(this.scene, { beams: false });
        view.show(this.opts.colorOf(c.id));
        d = { view, label: null, seen: true };
        this.driven.set(c.id, d);
      }
      d.seen = true;
      d.view.setPose(c);
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
    for (const d of this.driven.values()) d.label?.dispose();
    this.walkers.clear();
    this.driven.clear();
    this.parked.setHidden(new Set());
  }
}
