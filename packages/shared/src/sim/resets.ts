import { RESET_AFTER_S, RESET_CLEAR_RADIUS, TICK_HZ } from '../net/constants';
import type { WorldSim } from './world-sim';

const AFTER_TICKS = RESET_AFTER_S * TICK_HZ;

/**
 * Puts things back where the manifest has them once nobody used them for RESET_AFTER_S: a driverless car away from
 * its spot (and not moving) and a lamp that lies. Nothing resets while any player is within RESET_CLEAR_RADIUS.
 * Call update() about once a second (it only reads the tick counter, no clock).
 */
export class ResetTimers {
  /** Tick of the last use/movement per car and per lamp. */
  private readonly car: number[] = [];
  private readonly lamp: number[] = [];

  update(sim: WorldSim): void {
    const now = sim.tick;
    const players = sim.playerPoints();
    const clear = (x: number, z: number) => players.every((p) => Math.hypot(p.x - x, p.z - z) > RESET_CLEAR_RADIUS);

    const awake = new Set(sim.cars.awake());
    for (let i = 0; i < sim.cars.count; i++) {
      this.car[i] ??= now;
      if (sim.cars.driver[i] !== null || awake.has(i) || !sim.cars.isMoved(i)) { this.car[i] = now; continue; }
      const p = sim.cars.poses[i]!;
      if (now - this.car[i]! >= AFTER_TICKS && clear(p.x, p.z)) {
        sim.cars.reset(i);
        this.car[i] = now;
      }
    }

    const lamps = sim.props.count;
    for (let i = 0; i < lamps; i++) {
      this.lamp[i] ??= now;
      if (sim.lampState(i) !== 'lying') { this.lamp[i] = now; continue; }
      const p = sim.props.lampPose(i);
      if (now - this.lamp[i]! >= AFTER_TICKS && clear(p.x, p.z)) {
        sim.props.standUp(i);
        this.lamp[i] = now;
      }
    }
  }
}
