// The dense cut and fill functions as they were before the pipeline moved to sparse edits (test only: the reference
// terrainCutEdits and terrainFillEdits are compared against). Copied verbatim; do not change.
import type { TerrainGrid } from '@nn/shared';

/** The terrain ends this far below a cut surface. */
export const CUT_MARGIN = 0.05;
/**
 * Grid points up to this far outside a cut's footprint are lowered to the height of its nearest edge: the terrain
 * between a lowered point and an untouched one slopes across one 1 m cell, and that slope must not rise into the
 * model's edges (the outermost steps, a cheek wall).
 */
export const CUT_REACH = 1.0;

type P2 = { x: number; z: number };

/** Closest point to p on the triangle a, b, c (in xz) and its barycentric weights. */
function closest(p: P2, a: P2, b: P2, c: P2): { d: number; w: [number, number, number] } {
  const v0x = b.x - a.x, v0z = b.z - a.z, v1x = c.x - a.x, v1z = c.z - a.z, v2x = p.x - a.x, v2z = p.z - a.z;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) > 1e-12) {
    const wb = (v2x * v1z - v1x * v2z) / den;
    const wc = (v0x * v2z - v2x * v0z) / den;
    if (wb >= 0 && wc >= 0 && wb + wc <= 1) return { d: 0, w: [1 - wb - wc, wb, wc] };
  }
  // outside: the nearest point on one of the edges
  let best = { d: Infinity, w: [1, 0, 0] as [number, number, number] };
  const edges: [P2, P2, number, number][] = [[a, b, 0, 1], [b, c, 1, 2], [c, a, 2, 0]];
  for (const [e0, e1, i0, i1] of edges) {
    const ex = e1.x - e0.x, ez = e1.z - e0.z;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - e0.x) * ex + (p.z - e0.z) * ez) / len2)) : 0;
    const d = Math.hypot(e0.x + ex * t - p.x, e0.z + ez * t - p.z);
    if (d < best.d) {
      const w: [number, number, number] = [0, 0, 0];
      w[i0] = 1 - t;
      w[i1] = t;
      best = { d, w };
    }
  }
  return best;
}

/**
 * Lowers the terrain under cut surfaces (triangles in world space, 9 floats each, e.g. a ramp along the inner corners
 * of a flight of stairs) to CUT_MARGIN below them, so that the ground never shows through a model that sits lower
 * than the terrain model says (DGM1 smooths steps and walls into slopes). Grid points within CUT_REACH outside a cut
 * take the height of its nearest edge. Heights are only ever lowered. Returns the number of grid points changed.
 */
export function applyTerrainCuts(t: TerrainGrid, tris: Float32Array): number {
  const target = new Float32Array(t.heights.length).fill(Infinity);
  const dist = new Float32Array(t.heights.length).fill(Infinity);
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const a = { x: tris[i]!, z: tris[i + 2]! }, b = { x: tris[i + 3]!, z: tris[i + 5]! }, c = { x: tris[i + 6]!, z: tris[i + 8]! };
    const ya = tris[i + 1]!, yb = tris[i + 4]!, yc = tris[i + 7]!;
    const c0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) - CUT_REACH - t.x0));
    const c1 = Math.min(t.cols - 1, Math.ceil(Math.max(a.x, b.x, c.x) + CUT_REACH - t.x0));
    const r0 = Math.max(0, Math.floor(Math.min(a.z, b.z, c.z) - CUT_REACH - t.z0));
    const r1 = Math.min(t.rows - 1, Math.ceil(Math.max(a.z, b.z, c.z) + CUT_REACH - t.z0));
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const p = { x: t.x0 + col, z: t.z0 + r };
        const { d, w } = closest(p, a, b, c);
        if (d > CUT_REACH) continue;
        const k = r * t.cols + col;
        const y = w[0] * ya + w[1] * yb + w[2] * yc - CUT_MARGIN;
        // the nearest cut wins; where several cover a point (d = 0), the lowest
        if (d < dist[k]! - 1e-6 || (Math.abs(d - dist[k]!) <= 1e-6 && y < target[k]!)) {
          dist[k] = d;
          target[k] = y;
        }
      }
    }
  }
  let changed = 0;
  for (let k = 0; k < t.heights.length; k++) {
    if (target[k]! < t.heights[k]!) {
      t.heights[k] = target[k]!;
      changed++;
    }
  }
  return changed;
}

/** Fill skirts: outside a fill surface the terrain falls away at this slope (1:2) … */
export const FILL_SLOPE = 0.5;
/** … for at most this far (m). */
export const FILL_REACH = 12;

/**
 * The counterpart of applyTerrainCuts: raises the terrain up to fill surfaces (triangles in world space, 9 floats
 * each, e.g. the ramp behind a bridge abutment), so that a model or deck that sits higher than the DGM (a quay edge
 * smoothed into a slope, a dip in front of a wall) meets the ground. Inside a fill the terrain takes the surface
 * height; up to FILL_REACH outside it a skirt slopes down from the nearest edge at FILL_SLOPE. Heights are only ever
 * raised; grid points flagged in `keep` (e.g. the water) stay as they are. Returns the number of grid points changed.
 */
export function applyTerrainFills(t: TerrainGrid, tris: Float32Array, keep?: Uint8Array): number {
  const target = new Float32Array(t.heights.length).fill(-Infinity);
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const a = { x: tris[i]!, z: tris[i + 2]! }, b = { x: tris[i + 3]!, z: tris[i + 5]! }, c = { x: tris[i + 6]!, z: tris[i + 8]! };
    const ya = tris[i + 1]!, yb = tris[i + 4]!, yc = tris[i + 7]!;
    const c0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) - FILL_REACH - t.x0));
    const c1 = Math.min(t.cols - 1, Math.ceil(Math.max(a.x, b.x, c.x) + FILL_REACH - t.x0));
    const r0 = Math.max(0, Math.floor(Math.min(a.z, b.z, c.z) - FILL_REACH - t.z0));
    const r1 = Math.min(t.rows - 1, Math.ceil(Math.max(a.z, b.z, c.z) + FILL_REACH - t.z0));
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const { d, w } = closest({ x: t.x0 + col, z: t.z0 + r }, a, b, c);
        if (d > FILL_REACH) continue;
        const k = r * t.cols + col;
        // the highest fill wins
        target[k] = Math.max(target[k]!, w[0] * ya + w[1] * yb + w[2] * yc - d * FILL_SLOPE);
      }
    }
  }
  let changed = 0;
  for (let k = 0; k < t.heights.length; k++) {
    if (target[k]! > t.heights[k]! && !keep?.[k]) {
      t.heights[k] = target[k]!;
      changed++;
    }
  }
  return changed;
}
