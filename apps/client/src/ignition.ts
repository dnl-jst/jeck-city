import { CRANK_AT, DOOR_CLOSE_AT, ENGINE_CATCH_S, type IgnitionEvent } from '@nn/shared';

// the tick-based sequence lives in @nn/shared (sim/ignition.ts); this seconds-based variant drives Game until it runs on WorldSim
export { CRANK_AT, DOOR_CLOSE_AT, ENGINE_CATCH_S, type IgnitionEvent } from '@nn/shared';

const STEPS: { at: number; e: IgnitionEvent }[] = [
  { at: DOOR_CLOSE_AT, e: 'doorClose' }, { at: CRANK_AT, e: 'crank' }, { at: CRANK_AT + ENGINE_CATCH_S, e: 'running' },
];

/** Getting into a car: door shut, starter, engine running. Throttle, radio and lights wait for 'running'. */
export class Ignition {
  private s: 'off' | 'starting' | 'running' = 'off';
  private t = 0;
  /** Index of the next event in STEPS. */
  private next = 0;

  get state(): 'off' | 'starting' | 'running' {
    return this.s;
  }

  start(): void {
    this.s = 'starting';
    this.t = 0;
    this.next = 0;
  }

  stop(): void {
    this.s = 'off';
  }

  /** Advances the sequence; returns the events that fell into this step (in order). */
  update(dt: number): IgnitionEvent[] {
    if (this.state !== 'starting') return [];
    this.t += dt;
    const out: IgnitionEvent[] = [];
    while (this.next < STEPS.length && this.t >= STEPS[this.next]!.at - 1e-9) out.push(STEPS[this.next++]!.e);
    if (this.next === STEPS.length) this.s = 'running';
    return out;
  }

  /** Lamp power 0..1: dark until the starter turns, flickering (new each frame) while cranking, full once running. */
  lightPower(rand: () => number): number {
    if (this.state === 'running') return 1;
    if (this.state === 'off' || this.t < CRANK_AT - 1e-9) return 0;
    return 0.25 + 0.35 * rand();
  }
}
