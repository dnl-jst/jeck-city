/** Seconds after getting in: the door shuts, then the starter cranks. */
export const DOOR_CLOSE_AT = 0.35, CRANK_AT = 0.5;
/**
 * Seconds into engine-start.ogg at which the engine has caught and runs. Measured with ffmpeg
 * (astats RMS in 50 ms windows, 48 kHz → asetnsamples=n=2400): the starter cranks at -30..-33 dB up to 0.80 s,
 * the engine fires at 0.85 s (-22 dB) and runs from 0.90 s (-13 dB; a flare to ~1.8 s, then steady idle at -21 dB).
 */
export const ENGINE_CATCH_S = 0.9;

export type IgnitionEvent = 'doorClose' | 'crank' | 'running';

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
