import type { StationId } from './stations';

/** Wheel segments clockwise from the top: top, right, bottom, left (null = radio off). */
export const WHEEL_SLOTS: readonly (StationId | null)[] = ['koellefornia', 'radiokoeln', 'einslive', null];
/** R held at least this long (s) opens the wheel; a shorter press is a tap (next station). */
export const HOLD_S = 0.2, PICK_RADIUS_PX = 40;
const MAX_LEN = 2 * PICK_RADIUS_PX;

export type WheelState = { open: boolean; highlighted: StationId | null; commit?: StationId | null; tap?: true };

/**
 * Hold-R radio wheel logic: tap = next station, hold = open the wheel, point with the mouse, release to pick.
 * Mouse movement while open adds up to a vector (clamped to 2·PICK_RADIUS_PX); screen coordinates (dy > 0 = down).
 */
export class WheelControl {
  private holding = false;
  private heldFor = 0;
  private open = false;
  private vx = 0;
  private vy = 0;
  /** After cancel(): ignore R until it has been let go. */
  private waitRelease = false;

  update(i: { held: boolean; dx: number; dy: number; dt: number; current: StationId | null }): WheelState {
    if (this.waitRelease) {
      if (!i.held) this.waitRelease = false;
      return { open: false, highlighted: i.current };
    }
    if (i.held) {
      if (!this.holding) {
        this.holding = true;
        this.heldFor = 0;
      }
      this.heldFor += i.dt;
      if (!this.open && this.heldFor >= HOLD_S) {
        this.open = true;
        this.vx = this.vy = 0;
      } else if (this.open) {
        this.vx += i.dx;
        this.vy += i.dy;
        const len = Math.hypot(this.vx, this.vy);
        if (len > MAX_LEN) {
          this.vx *= MAX_LEN / len;
          this.vy *= MAX_LEN / len;
        }
      }
      return { open: this.open, highlighted: this.open ? this.pick(i.current) : i.current };
    }
    if (!this.holding) return { open: false, highlighted: i.current };
    const wasOpen = this.open;
    const highlighted = this.pick(i.current);
    this.reset();
    return wasOpen ? { open: false, highlighted, commit: highlighted } : { open: false, highlighted: i.current, tap: true };
  }

  /**
   * Closes the wheel without a pick (getting out, flying, engine not running). If R is held (`held`), it must be
   * let go before it counts again; a cancel while R is up must not swallow the next press.
   */
  cancel(held = true): void {
    this.reset();
    this.waitRelease = held;
  }

  private pick(current: StationId | null): StationId | null {
    if (Math.hypot(this.vx, this.vy) < PICK_RADIUS_PX) return current;
    // angle clockwise from screen-up; each slot covers ±45°
    const a = Math.atan2(this.vx, -this.vy);
    return WHEEL_SLOTS[(Math.round(a / (Math.PI / 2)) + 4) % 4]!;
  }

  private reset(): void {
    this.holding = this.open = false;
    this.heldFor = this.vx = this.vy = 0;
  }
}
