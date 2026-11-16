import type { RemoteCarInfo } from './remote/remote-players';
import {
  FixedStepper, TUNING, type PlayerId, type PlayerInput, type SimEvent, type SnapshotCar, type SnapshotRider, type SnapshotWalker, type StationId,
  type WorldSim,
} from '@nn/shared';

/**
 * Where the game's world comes from: a WorldSim the client steps (offline) or, later, one that follows a server.
 * Game renders `sim` and feeds the local player's input in through frame().
 */
export interface Session {
  readonly sim: WorldSim;
  readonly me: PlayerId;
  /**
   * Adds dt seconds of frame time and runs the fixed steps due. `input.use`, `input.jump` and `input.bell` mean
   * "pressed since the last frame": they reach the sim as a one-tick pulse in the next step. radioCmd: the station to set in the own car
   * (undefined = unchanged). Returns the events of all steps run.
   */
  frame(dt: number, input: PlayerInput, radioCmd?: StationId | null): SimEvent[];
  /** Fraction (0..1) of a step accumulated since the last one: blend previous → current state by it. */
  readonly alpha: number;
  /** Fixed steps run so far. */
  readonly steps: number;
  /** Called after every fixed step (to sample states for interpolation). */
  onStep: (() => void) | null;
  /**
   * Called when a server correction replaced the own state between steps (online only): the samples of the last step
   * are moved along with it, renderOffset() keeps the rendered pose where it was.
   */
  onCorrection: (() => void) | null;
  /** Added to the own figure's / car's rendered pose: position (m) and a rotation applied on top (online: a fading correction). */
  renderOffset(): RenderOffset;
  /** Online only: other players (on foot, driving, riding), cars and names as of this frame. */
  remote?(): { walkers: ReadonlyMap<string, SnapshotWalker>; cars: ReadonlyMap<string, SnapshotCar>; riders: ReadonlyMap<string, SnapshotRider> };
  roster?(): { names: ReadonlyMap<number, string>; variants: ReadonlyMap<number, number>; cars: ReadonlyMap<number, RemoteCarInfo> };
  /** Online only: the own character variant (index into CHARACTER_VARIANTS) changed. */
  setVariant?(v: number): void;
}

/** Position offset and rotation offset (quaternion, applied before the pose's own rotation). */
export type RenderOffset = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
const NO_OFFSET: RenderOffset = Object.freeze({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });

/** Single player without a server: the local WorldSim is stepped directly at 60 Hz. */
export class OfflineSession implements Session {
  steps = 0;
  onStep: (() => void) | null = null;
  onCorrection: (() => void) | null = null;
  private readonly stepper = new FixedStepper(TUNING.world.dt, 5);
  /** use/jump/bell pressed but not yet sent in a step. */
  private use = false;
  private jump = false;
  private bell = false;

  constructor(readonly sim: WorldSim, readonly me: PlayerId) {}

  get alpha(): number {
    return this.stepper.alpha;
  }

  renderOffset(): RenderOffset {
    return NO_OFFSET;
  }

  frame(dt: number, input: PlayerInput, radioCmd?: StationId | null): SimEvent[] {
    if (radioCmd !== undefined) this.sim.setRadio(this.me, radioCmd);
    this.use ||= input.use;
    this.jump ||= input.jump;
    this.bell ||= input.bell === true;
    const ev: SimEvent[] = [];
    this.stepper.advance(dt, () => {
      const i: PlayerInput = { ...input, use: this.use, jump: this.jump, bell: this.bell };
      this.use = this.jump = this.bell = false;
      for (const e of this.sim.step(new Map([[this.me, i]]))) ev.push(e);
      this.steps++;
      this.onStep?.();
    });
    return ev;
  }
}
