export type DriveControls = { forward: number; right: number; brake: boolean; run: boolean };

/** Whether the big map is open; while it is, the game ignores steering input. */
export class MapMode {
  open = false;
  private closed = false;

  toggle(): void {
    this.open = !this.open;
    if (!this.open) this.closed = true;
  }

  /** Losing pointer lock (Esc) closes an open map; gaining it never opens one. */
  onLockChange(locked: boolean): void {
    if (!locked && this.open) this.toggle();
  }

  /** Open map: all controls neutral (the car just rolls on). */
  gate(s: DriveControls): DriveControls {
    return this.open ? { forward: 0, right: 0, brake: false, run: false } : s;
  }

  /** True once after the map went from open to closed. */
  takeClosed(): boolean {
    const c = this.closed;
    this.closed = false;
    return c;
  }
}
