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

  /** Fraction (0..1) of a step already accumulated: blend previous → current physics state by it when rendering. */
  get alpha(): number {
    return this.acc / this.step;
  }

  /**
   * Adds dt seconds of frame time and calls fn once per fixed step due. Returns the number of steps run.
   * A NaN, negative or infinite dt (clock glitches) counts as 0.
   */
  advance(dt: number, fn: () => void): number {
    if (Number.isFinite(dt) && dt > 0) this.acc += dt;
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
