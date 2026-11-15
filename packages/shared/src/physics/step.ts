import { TUNING } from './tuning';

/**
 * Turns variable frame times into a whole number of fixed physics steps.
 * At most maxSteps run per call; any further backlog is dropped (a long frame,
 * e.g. a backgrounded tab, must not trigger a spiral of catch-up steps).
 */
export class FixedStepper {
  private acc = 0;

  constructor(
    readonly step = TUNING.world.dt,
    readonly maxSteps = 5,
  ) {}

  /** Adds dt seconds of frame time and calls fn once per fixed step due. Returns the number of steps run. */
  advance(dt: number, fn: () => void): number {
    this.acc += dt;
    let n = 0;
    // A tiny tolerance so that e.g. three frames of 1/60 s give three steps despite rounding.
    const eps = 1e-9;
    while (this.acc + eps >= this.step && n < this.maxSteps) {
      fn();
      this.acc -= this.step;
      n++;
    }
    if (this.acc + eps >= this.step) this.acc = 0;
    if (this.acc < 0) this.acc = 0;
    return n;
  }
}
