import type { Camera, Mesh, Object3D, Scene } from 'three';
import {
  lineText, BIKE_GEAR, BIKE_SPECS, BIKE_TYPES, BIKE_WHEEL_RADIUS, bikeLean, CAR_TYPES, SUSPENSION_REST_LENGTH, VEHICLE_REST_Y, type BikeState, type BikeType,
} from '@nn/shared';
import { BikeRig, RIDER_POSTURE } from '../bikes/rig';
import { DrivenCar, type CarModels } from '../car';
import { PlayerFigure } from '../player';
import type { CarView, RemoteOptions, RiderRig } from '../remote/remote-players';
import type { NpcDraw } from './npc-feed';
import { SpeechBubble, type Bubble } from './speech-bubble';

/** Figures (walkers, sitters, cyclists) farther than this (m) are not drawn; cars up to the render radius. */
const FIGURE_RANGE = 150;
const CAR_RANGE = 250;
/** Beyond this distance (m) figures are animated every second frame only. */
const HALF_RATE_FROM = 60;
/** A sitter looks at the camera when it is this close (m). */
const LOOK_AT = 4;
/** Hip height (m) of a sitter on a bench and on the lawn. */
const BENCH_H = 0.45, LAWN_H = 0.12;
const CRANK_PER_M = 1 / (BIKE_WHEEL_RADIUS * BIKE_GEAR);

export type NpcViewOptions = Pick<RemoteOptions, 'figureFor' | 'figureModel' | 'bikeModels' | 'bikeGroundPose' | 'makeRig' | 'occluded' | 'makeCar'> & {
  carModels?: CarModels;
  quality?: () => 'low' | 'medium' | 'high';
  makeBubble?: (text: string) => Bubble;
};

/** Gap (m) between the top of a head (or a car roof) and a bubble's tip; a figure's height and a car roof's (m). */
const BUBBLE_GAP = 0.3, FIGURE_H = 1.8, SEATED_H = 1.3, ROOF_H = 1.5;

type Fig = { fig: PlayerFigure; model: Object3D | null | undefined; shadows: boolean | null };
type Npc = {
  kind: NpcDraw['kind']; fig: Fig | null; rig: RiderRig | null; car: CarView | null; seen: boolean;
  crank: number; lastSpeed: number; frame: number; talk: number;
  bubble: { b: Bubble; line: number } | null;
};

/**
 * Draws the NPCs: walkers and sitters as character figures (pooled, the variant from their look, sized by look.scale),
 * cyclists as a figure on a rig of their bike's model, drivers as a car (DrivenCar without headlight beams, brake
 * lights while slowing down). Figures beyond 150 m are not drawn; far ones are animated every second frame; at the
 * low graphics level NPC figures cast no shadows.
 */
export class NpcView {
  private readonly npcs = new Map<number, Npc>();
  private readonly freeFigs: Fig[] = [];
  private readonly freeRigs = new Map<BikeType, RiderRig[]>();
  private readonly freeCars: CarView[] = [];
  private frameNo = 0;

  constructor(private readonly scene: Scene, private readonly opts: NpcViewOptions) {}

  /** Live and pooled figures (tests, debug). */
  counts(): { figures: number; pooledFigures: number; cars: number } {
    let figures = 0, cars = 0;
    for (const n of this.npcs.values()) {
      if (n.fig) figures++;
      if (n.car) cars++;
    }
    return { figures, pooledFigures: this.freeFigs.length, cars };
  }

  /** The figure of NPC id (tests). */
  figureOf(id: number): PlayerFigure | null {
    return this.npcs.get(id)?.fig?.fig ?? null;
  }

  update(draws: readonly NpcDraw[], camera: Camera, night: number, dt: number): void {
    this.frameNo++;
    const cp = camera.position;
    const low = this.opts.quality?.() === 'low';
    // the ones gone first, so their figures, rigs and cars can be reused in this frame
    const wanted = new Set<number>();
    for (const d of draws) {
      const range = d.kind === 'driver' ? CAR_RANGE : FIGURE_RANGE;
      if (d.alpha > 0.02 && Math.hypot(d.pose.x - cp.x, d.pose.z - cp.z) <= range) wanted.add(d.id);
    }
    for (const [id, n] of this.npcs) {
      if (wanted.has(id)) continue;
      this.release(n);
      this.npcs.delete(id);
    }
    for (const n of this.npcs.values()) n.seen = false;
    for (const d of draws) {
      const dist = Math.hypot(d.pose.x - cp.x, d.pose.z - cp.z);
      const isCar = d.kind === 'driver';
      if (dist > (isCar ? CAR_RANGE : FIGURE_RANGE) || d.alpha <= 0.02) continue;
      let n = this.npcs.get(d.id);
      if (!n) {
        n = { kind: d.kind, fig: null, rig: null, car: null, seen: true, crank: 0, lastSpeed: d.pose.speed, frame: d.id % 2, talk: d.id * 1.3, bubble: null };
        this.npcs.set(d.id, n);
      }
      n.seen = true;
      this.speak(n, d, dist);
      if (isCar) this.drawCar(n, d, night, camera, dt);
      else {
        // far figures: every second frame (with twice the time step)
        if (dist > HALF_RATE_FROM && (this.frameNo + n.frame) % 2) continue;
        const step = dist > HALF_RATE_FROM ? 2 * dt : dt;
        if (!n.fig) n.fig = this.takeFig();
        this.dress(n.fig, d.look.variant, !low);
        n.fig.fig.group.scale.setScalar(d.look.scale);
        if (d.kind === 'cyclist') this.drawCyclist(n, d, night, step);
        else if (d.kind === 'sitter') {
          n.talk += step * 2.2;
          const look = dist < LOOK_AT ? lookYaw(d, cp.x, cp.z) : 0;
          n.fig.fig.sit(d.pose.x, d.pose.y, d.pose.z, d.pose.heading, d.look.vehicleType === 0 ? LAWN_H : BENCH_H, n.talk, look);
        } else {
          const f = n.fig.fig;
          f.setDown(d.action === 'down' ? 1 : 0);
          const v = d.pose.speed;
          f.update(d.pose.x, d.pose.y, d.pose.z, { x: Math.sin(d.pose.heading) * v, y: 0, z: Math.cos(d.pose.heading) * v }, step);
          if (v < 0.2) f.heading += Math.atan2(Math.sin(d.pose.heading - f.heading), Math.cos(d.pose.heading - f.heading)) * Math.min(1, step * 6);
        }
      }
    }
    for (const [id, n] of this.npcs) {
      if (n.seen) continue;
      this.release(n);
      this.npcs.delete(id);
    }
  }

  /** The bubble of what n says, over its head (drivers: over the driver's side of the roof). */
  private speak(n: Npc, d: NpcDraw, dist: number): void {
    if (!d.say) {
      if (n.bubble) {
        n.bubble.b.dispose();
        n.bubble = null;
      }
      return;
    }
    if (!n.bubble || n.bubble.line !== d.say.line) {
      n.bubble?.b.dispose();
      const b = this.opts.makeBubble?.(lineText(d.say.line) ?? '…') ?? new SpeechBubble(lineText(d.say.line) ?? '…');
      b.attach(this.scene);
      n.bubble = { b, line: d.say.line };
    }
    const h = d.pose.heading;
    if (d.kind === 'driver') {
      // the driver sits on the left: left of the heading is (cos h, −sin h)
      n.bubble.b.place(d.pose.x + Math.cos(h) * 0.4, d.pose.y + ROOF_H + BUBBLE_GAP, d.pose.z - Math.sin(h) * 0.4, dist, d.say.age);
    } else {
      const top = (d.kind === 'sitter' ? SEATED_H : FIGURE_H) * d.look.scale;
      n.bubble.b.place(d.pose.x, d.pose.y + top + BUBBLE_GAP, d.pose.z, dist, d.say.age);
    }
  }

  private drawCar(n: Npc, d: NpcDraw, night: number, camera: Camera, dt: number): void {
    const type = CAR_TYPES[d.look.vehicleType] ?? CAR_TYPES[0]!;
    if (!n.car) {
      n.car = this.freeCars.pop() ?? this.opts.makeCar?.() ?? new DrivenCar(this.scene, this.opts.carModels, { beams: false });
      n.car.show(type, d.look.vehicleColor);
    }
    const h = d.pose.heading, pitch = d.pose.pitch;
    // yaw about +y, then pitch nose up about the car's x axis
    const cy = Math.cos(h / 2), sy = Math.sin(h / 2), cx = Math.cos(-pitch / 2), sx = Math.sin(-pitch / 2);
    n.car.setPose({ x: d.pose.x, y: d.pose.y + VEHICLE_REST_Y, z: d.pose.z, qx: cy * sx, qy: sy * cx, qz: -sy * sx, qw: cy * cx });
    const speed = d.pose.speed;
    n.car.setWheels({ speed: () => speed, wheelSteering: () => 0, wheelSuspension: () => SUSPENSION_REST_LENGTH }, dt);
    const braking = speed < n.lastSpeed - 0.02 || (speed < 0.05 && d.action !== 'move');
    n.lastSpeed = speed;
    n.car.setLights(night, braking, 1);
    n.car.updateGlare(camera, this.opts.occluded, dt);
  }

  private drawCyclist(n: Npc, d: NpcDraw, night: number, dt: number): void {
    const type: BikeType = BIKE_TYPES[d.look.vehicleType] ?? 'dutch';
    if (n.rig && n.rig.type !== type) this.freeRig(n);
    if (!n.rig) n.rig = this.takeRig(type);
    const f = n.fig!.fig;
    if (d.action === 'down') {
      // thrown off: the figure lies, the bike is not drawn
      if (n.rig) this.freeRig(n);
      f.setDown(1);
      f.update(d.pose.x, d.pose.y, d.pose.z, { x: 0, y: 0, z: 0 }, dt);
      return;
    }
    f.setDown(0);
    n.crank += d.pose.speed * CRANK_PER_M * dt;
    const st: BikeState = { x: d.pose.x, y: d.pose.y, z: d.pose.z, heading: d.pose.heading, speed: d.pose.speed, steer: 0, vy: 0, grounded: true, crank: n.crank };
    const rig = n.rig;
    if (!rig) {
      f.update(d.pose.x, d.pose.y, d.pose.z, { x: Math.sin(d.pose.heading) * d.pose.speed, y: 0, z: Math.cos(d.pose.heading) * d.pose.speed }, dt);
      return;
    }
    rig.setColor(d.look.vehicleColor);
    rig.update(st, bikeLean(BIKE_SPECS[type], d.pose.speed, 0), dt, this.opts.bikeGroundPose?.(type, st));
    rig.setLights(night);
    if (f.group.parent !== rig.leanGroup) rig.leanGroup.add(f.group);
    f.ride(rig.localPoint('seat'), [rig.localPoint('grip_l'), rig.localPoint('grip_r')], [rig.localPoint('pedal_l'), rig.localPoint('pedal_r')], RIDER_POSTURE[type]);
  }

  private takeFig(): Fig {
    const f = this.freeFigs.pop() ?? { fig: new PlayerFigure(this.scene), model: undefined, shadows: null };
    f.fig.visible = true;
    return f;
  }

  private dress(f: Fig, variant: number, shadows: boolean): void {
    const model = this.opts.figureFor?.(variant) ?? this.opts.figureModel ?? null;
    if (f.model !== model) {
      f.fig.setModel(model);
      f.model = model;
      f.shadows = null;
    }
    if (f.shadows !== shadows) {
      f.fig.group.traverse((o) => { if ((o as Mesh).isMesh) o.castShadow = shadows; });
      f.shadows = shadows;
    }
  }

  private takeRig(type: BikeType): RiderRig | null {
    const pooled = this.freeRigs.get(type)?.pop();
    if (pooled) {
      pooled.root.visible = true;
      return pooled;
    }
    const model = this.opts.bikeModels?.get(type);
    const rig = this.opts.makeRig?.(type) ?? (model ? new BikeRig(model.clone(true), type) : null);
    if (rig && !rig.root.parent) this.scene.add(rig.root);
    return rig;
  }

  private freeRig(n: Npc): void {
    const r = n.rig;
    if (!r) return;
    if (n.fig && n.fig.fig.group.parent === r.leanGroup) this.scene.add(n.fig.fig.group);
    r.root.visible = false;
    const list = this.freeRigs.get(r.type) ?? [];
    list.push(r);
    this.freeRigs.set(r.type, list);
    n.rig = null;
  }

  private release(n: Npc): void {
    n.bubble?.b.dispose();
    n.bubble = null;
    this.freeRig(n);
    if (n.fig) {
      const f = n.fig;
      f.fig.visible = false;
      f.fig.reset();
      f.fig.group.scale.setScalar(1);
      if (f.fig.group.parent !== this.scene) this.scene.add(f.fig.group);
      this.freeFigs.push(f);
      n.fig = null;
    }
    if (n.car) {
      n.car.hide();
      this.freeCars.push(n.car);
      n.car = null;
    }
  }

  dispose(): void {
    for (const n of this.npcs.values()) this.release(n);
    this.npcs.clear();
  }
}

/** Head turn (rad, + = left) for a sitter at d to look at (x, z), limited to ±70°. */
function lookYaw(d: NpcDraw, x: number, z: number): number {
  const want = Math.atan2(x - d.pose.x, z - d.pose.z);
  const a = Math.atan2(Math.sin(want - d.pose.heading), Math.cos(want - d.pose.heading));
  return Math.max(-1.2, Math.min(1.2, a));
}
