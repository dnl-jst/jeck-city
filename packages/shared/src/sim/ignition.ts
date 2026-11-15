import { TICK_HZ } from '../net/constants';

/** Seconds after getting in: the door shuts, then the starter cranks. */
export const DOOR_CLOSE_AT = 0.35, CRANK_AT = 0.5;
/**
 * Seconds into engine-start.ogg at which the engine has caught and runs. Measured with ffmpeg
 * (astats RMS in 50 ms windows, 48 kHz → asetnsamples=n=2400): the starter cranks at -30..-33 dB up to 0.80 s,
 * the engine fires at 0.85 s (-22 dB) and runs from 0.90 s (-13 dB; a flare to ~1.8 s, then steady idle at -21 dB).
 */
export const ENGINE_CATCH_S = 0.9;

export type IgnitionEvent = 'doorClose' | 'crank' | 'running';
export type IgnitionState = 'off' | 'starting' | 'running';

const ticks = (s: number): number => Math.round(s * TICK_HZ);
/** Tick (counted from start(), first update() = tick 1) at which each event fires. */
const STEPS: { at: number; e: IgnitionEvent }[] = [
  { at: ticks(DOOR_CLOSE_AT), e: 'doorClose' }, { at: ticks(CRANK_AT), e: 'crank' }, { at: ticks(CRANK_AT + ENGINE_CATCH_S), e: 'running' },
];

/** Getting into a car, counted in simulation ticks: door shut, starter, engine running. Throttle, radio and lights wait for 'running'. */
export class Ignition {
  private s: IgnitionState = 'off';
  private t = 0;
  /** Index of the next event in STEPS. */
  private next = 0;

  get state(): IgnitionState {
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

  /** Advances one tick; returns the events that fell into it (in order). */
  update(): IgnitionEvent[] {
    if (this.s !== 'starting') return [];
    this.t++;
    const out: IgnitionEvent[] = [];
    while (this.next < STEPS.length && this.t >= STEPS[this.next]!.at) out.push(STEPS[this.next++]!.e);
    if (this.next === STEPS.length) this.s = 'running';
    return out;
  }

  /** Lamp power: 0 until the starter turns, 0.5 while cranking (the client flickers it), 1 once running. */
  lightLevel(): 0 | 0.5 | 1 {
    if (this.s === 'running') return 1;
    if (this.s === 'off' || this.t < STEPS[1]!.at) return 0;
    return 0.5;
  }
}
