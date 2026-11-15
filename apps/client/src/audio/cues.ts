const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Absorbs float accumulation error (e.g. 120 x 1/60 steps). */
const EPS = 1e-6;

/** Footstep timing: one step per half animation cycle (matches PlayerFigure). */
export class StepClock {
  private dist = 0;

  update(groundSpeed: number, grounded: boolean, dt: number): boolean {
    if (!grounded) {
      this.dist = 0;
      return false;
    }
    if (groundSpeed < 0.3) return false;
    const stride = groundSpeed > 3 ? 1.5 : 0.75;
    this.dist += groundSpeed * dt;
    if (this.dist >= stride - EPS) {
      this.dist = Math.max(0, this.dist - stride);
      return true;
    }
    return false;
  }
}

/** True on the air-to-ground transition after more than 0.25 s of air time. */
export function landed(wasGrounded: boolean, grounded: boolean, airTime: number): boolean {
  return !wasGrounded && grounded && airTime > 0.25;
}

/** Detects sudden velocity loss (deceleration above 25 m/s^2); returns strength 0..1. */
export class ImpactDetector {
  private prev: { vx: number; vz: number } | null = null;
  private lock = 0;

  update(vx: number, vz: number, dt: number): number {
    const prev = this.prev;
    this.prev = { vx, vz };
    this.lock = Math.max(0, this.lock - dt);
    if (!prev || dt <= 0) return 0;
    const dv = Math.hypot(prev.vx - vx, prev.vz - vz);
    if (this.lock > 0 || dv / dt <= 25) return 0;
    this.lock = 0.4;
    return clamp(dv / 8, 0.15, 1);
  }
}

export function skidAmount(forwardSpeed: number, lateralSpeed: number, handbrake: boolean): number {
  let s = clamp((Math.abs(lateralSpeed) - 1.5) / 4, 0, 1);
  if (handbrake && Math.abs(forwardSpeed) > 3) s = Math.max(s, clamp(Math.abs(forwardSpeed) / 12, 0, 1));
  return s;
}

/** Rings at random 60-180 s intervals while within 80 m of a tram stop. */
export class TramBell {
  private timer: number;

  constructor(private readonly rand: () => number) {
    this.timer = this.nextInterval();
  }

  private nextInterval(): number {
    return 60 + this.rand() * 120;
  }

  update(dt: number, distToStop: number): boolean {
    if (distToStop >= 80) return false;
    this.timer -= dt;
    if (this.timer <= EPS) {
      this.timer = this.nextInterval();
      return true;
    }
    return false;
  }
}
