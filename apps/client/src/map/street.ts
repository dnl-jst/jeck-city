import type { MapData } from '@nn/shared';
import type { MapGrid } from './grid';

const MAX_DIST = 25;
/** A different name only replaces the current one if it is at least this much closer (m). */
const SWITCH_MARGIN = 4;

function distToPolyline(pts: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i]!, az = pts[i + 1]!;
    const dx = pts[i + 2]! - ax, dz = pts[i + 3]! - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

/** Tracks the name of the street the player is on, with hysteresis at junctions. */
export class StreetTracker {
  private current = '';

  constructor(private readonly data: MapData, private readonly grid: MapGrid) {}

  /** Returns the current street name, '' if no named road is within MAX_DIST. */
  update(x: number, z: number): string {
    const near = new Map<string, number>();
    for (const i of this.grid.query(x - MAX_DIST, z - MAX_DIST, x + MAX_DIST, z + MAX_DIST).roads) {
      const r = this.data.roads[i]!;
      if (!r.name) continue;
      const d = distToPolyline(r.pts, x, z);
      if (d <= MAX_DIST && d < (near.get(r.name) ?? Infinity)) near.set(r.name, d);
    }
    let best = '';
    let bestD = Infinity;
    for (const [name, d] of near) if (d < bestD) { best = name; bestD = d; }
    const curD = near.get(this.current);
    // Keep the current name while it is still in range and nothing else is clearly closer.
    if (curD === undefined || bestD <= curD - SWITCH_MARGIN) this.current = best;
    return this.current;
  }
}
