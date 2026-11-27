import type { BuildingRecord } from './buildingstore.js';
import { footprintContains } from './footprint.js';
import type { Pt, Road } from './osm.js';
import { edgeAt } from './roadprofile.js';
import { cumulative, dedupe, DRIVABLE } from './polyline.js';

export const SIDEWALK_MIN = 1.5;
export const SIDEWALK_MAX = 8;
export const SIDEWALK_DEFAULT = 2.5;
/** Sidewalk widths are sampled at every vertex and at most this far apart along the way (m). */
export const SIDEWALK_STEP = 2;
const NEAR = 10; // a facade closer than this to the kerb defines the building line
const CELL = 50;

/** Uniform grid over building footprint bboxes, for the "buildings near a point" query. */
export type BuildingGrid = { near(p: Pt, r: number): BuildingRecord[] };

export function buildingGrid(buildings: readonly BuildingRecord[]): BuildingGrid {
  const cells = new Map<string, BuildingRecord[]>();
  for (const b of buildings) {
    const fp = b.footprint;
    if (!fp.tris.length) continue;
    for (let i = Math.floor(fp.minX / CELL); i <= Math.floor(fp.maxX / CELL); i++) {
      for (let k = Math.floor(fp.minZ / CELL); k <= Math.floor(fp.maxZ / CELL); k++) {
        const key = `${i},${k}`;
        const list = cells.get(key);
        if (list) list.push(b);
        else cells.set(key, [b]);
      }
    }
  }
  return {
    near(p, r) {
      const out = new Set<BuildingRecord>();
      for (let i = Math.floor((p.x - r) / CELL); i <= Math.floor((p.x + r) / CELL); i++) {
        for (let k = Math.floor((p.z - r) / CELL); k <= Math.floor((p.z + r) / CELL); k++) {
          for (const b of cells.get(`${i},${k}`) ?? []) {
            const fp = b.footprint;
            if (p.x >= fp.minX - r && p.x <= fp.maxX + r && p.z >= fp.minZ - r && p.z <= fp.maxZ + r) out.add(b);
          }
        }
      }
      return [...out];
    },
  };
}

/**
 * Nearest facade straight out from the kerb point k: the smallest distance t (0 ≤ t ≤ tmax) along the outward unit
 * direction d at which a footprint lies within the band |lateral offset| ≤ a (0 if k is inside a footprint);
 * Infinity if none. Unlike a single ray it sees a facade that steps forward beside k and does not pass through gaps
 * narrower than 2a.
 */
export function facadeDistance(buildings: readonly BuildingRecord[], k: Pt, d: Pt, a: number, tmax: number): number {
  const tx = -d.z, tz = d.x; // lateral axis
  let best = Infinity;
  for (const b of buildings) {
    if (footprintContains(b, k.x, k.z)) return 0;
    const t = b.footprint.tris;
    for (let i = 0; i < t.length; i += 6) {
      for (let e = 0; e < 3; e++) {
        const ax = t[i + e * 2]! - k.x, az = t[i + e * 2 + 1]! - k.z;
        const bx = t[i + ((e + 1) % 3) * 2]! - k.x, bz = t[i + ((e + 1) % 3) * 2 + 1]! - k.z;
        const u0 = ax * tx + az * tz, u1 = bx * tx + bz * tz;
        const t0 = ax * d.x + az * d.z, t1 = bx * d.x + bz * d.z;
        // clip the edge (parameter l in [0, 1]) to -a ≤ u ≤ a, 0 ≤ t ≤ min(tmax, best)
        let lo = 0, hi = 1;
        const keep = (f0: number, f1: number): boolean => { // f(l) = f0 + l (f1 - f0) ≥ 0
          if (f0 < 0 && f1 < 0) return false;
          if (f0 < 0) lo = Math.max(lo, f0 / (f0 - f1));
          else if (f1 < 0) hi = Math.min(hi, f0 / (f0 - f1));
          return lo <= hi;
        };
        const lim = Math.min(tmax, best);
        if (!keep(u0 + a, u1 + a) || !keep(a - u0, a - u1) || !keep(t0, t1) || !keep(lim - t0, lim - t1)) continue;
        best = Math.min(best, t0 + (t1 - t0) * lo, t0 + (t1 - t0) * hi);
      }
    }
  }
  return best;
}

/**
 * Sidewalk widths along a way, left and right of travel, at arc lengths `s`: every vertex of dedupe(road.points) plus
 * the samples (≤ SIDEWALK_STEP apart) where the width does not run linearly between its neighbours.
 */
export type SidewalkWidths = { s: number[]; left: number[]; right: number[] };

/** Width on side (+1 right of travel, -1 left) at arc length s (linear between samples, clamped). */
export function widthAt(w: SidewalkWidths, side: number, s: number): number {
  const v = side > 0 ? w.right : w.left;
  let i = 1;
  while (i < w.s.length - 1 && w.s[i]! < s) i++;
  const t = Math.min(1, Math.max(0, (s - w.s[i - 1]!) / (w.s[i]! - w.s[i - 1]! || 1)));
  return v[i - 1]! + (v[i]! - v[i - 1]!) * t;
}

/** Sample arc lengths: the vertices plus evenly spaced points so that no two are more than `step` apart. */
function sampleArcs(cum: number[], step: number): number[] {
  const out = [cum[0]!];
  for (let i = 1; i < cum.length; i++) {
    const n = Math.max(1, Math.ceil((cum[i]! - cum[i - 1]!) / step - 1e-9));
    for (let j = 1; j <= n; j++) out.push(j === n ? cum[i]! : cum[i - 1]! + ((cum[i]! - cum[i - 1]!) * j) / n);
  }
  return out;
}

const median3 = (v: number[]): number[] =>
  v.map((x, i) => [v[Math.max(0, i - 1)]!, x, v[Math.min(v.length - 1, i + 1)]!].sort((a, b) => a - b)[1]!);

/**
 * Sidewalk widths of a way, sampled every ≤ 2 m (SidewalkWidths), left and right of travel: from the kerb (that side's
 * edge of the road profile) to the building line, clamped to [1.5, 8] m. The building line at a sample is the
 * nearest facade straight out within a band of ±2 m (so the straight outer edge between two samples never reaches
 * into a facade that either sample's band sees); where no facade lies within 10 m in that band (a gap: side street,
 * passage, courtyard), the nearest facade within ±10 m, i.e. the neighbours' building line; 2.5 m where there is no
 * facade within 10 m of the kerb at all. Smoothed with a median over 3 samples on kerb + width (the outer edge's
 * distance from the centre line, so kerb ramps keep the facade line) that may only narrow a sample, never widen it.
 */
export function sidewalkWidths(road: Road, buildings: readonly BuildingRecord[], grid: BuildingGrid = buildingGrid(buildings)): SidewalkWidths {
  const pts = dedupe(road.points);
  const cum = cumulative(pts);
  const s = sampleArcs(cum, SIDEWALK_STEP);
  // position and unit normal (right of travel; mitred at vertices) of each sample
  const segNormal = (i: number): Pt => {
    const a = pts[i]!, b = pts[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  let seg = 0;
  const at = s.map((si) => {
    while (seg < pts.length - 2 && cum[seg + 1]! < si - 1e-9) seg++;
    const a = pts[seg]!, b = pts[seg + 1]!;
    const len = cum[seg + 1]! - cum[seg]! || 1;
    const t = Math.min(1, Math.max(0, (si - cum[seg]!) / len));
    const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    let n = segNormal(seg);
    const atVertex = t < 1e-9 ? seg : t > 1 - 1e-9 ? seg + 1 : -1;
    if (atVertex >= 0) {
      const n0 = segNormal(Math.max(0, atVertex - 1)), n1 = segNormal(Math.min(pts.length - 2, atVertex));
      const l = Math.hypot(n0.x + n1.x, n0.z + n1.z) || 1;
      n = { x: (n0.x + n1.x) / l, z: (n0.z + n1.z) / l };
    }
    return { p, n };
  });
  const width = (p: Pt, n: Pt, side: 1 | -1, kerb: number): number => {
    const d = { x: n.x * side, z: n.z * side };
    const k = { x: p.x + d.x * kerb, z: p.z + d.z * kerb };
    const cand = grid.near(k, 2 * NEAR);
    const ahead = facadeDistance(cand, k, d, SIDEWALK_STEP, NEAR);
    const line = ahead <= NEAR ? ahead : facadeDistance(cand, k, d, NEAR, NEAR);
    return line <= NEAR ? Math.min(SIDEWALK_MAX, Math.max(SIDEWALK_MIN, line)) : SIDEWALK_DEFAULT;
  };
  const side = (sd: 1 | -1): number[] => {
    const kerb = s.map((si) => edgeAt(road, sd, 'kerb', si));
    const own = at.map(({ p, n }, i) => kerb[i]! + width(p, n, sd, kerb[i]!));
    return median3(own).map((o, i) => Math.min(o, own[i]!) - kerb[i]!);
  };
  return simplify({ s, left: side(-1), right: side(1) }, new Set(cum));
}

/** Drops samples (never a vertex, arc lengths in `keep`) where both sides lie within 1 cm of the line between the kept neighbours. */
function simplify(w: SidewalkWidths, keep: ReadonlySet<number>): SidewalkWidths {
  const out: SidewalkWidths = { s: [w.s[0]!], left: [w.left[0]!], right: [w.right[0]!] };
  let last = 0;
  const fits = (j: number): boolean => { // the samples between `last` and j lie on the line between them
    for (let m = last + 1; m < j; m++) {
      const t = (w.s[m]! - w.s[last]!) / (w.s[j]! - w.s[last]! || 1);
      for (const v of [w.left, w.right]) if (Math.abs(v[last]! + (v[j]! - v[last]!) * t - v[m]!) > 0.01) return false;
    }
    return true;
  };
  for (let j = 1; j < w.s.length; j++) {
    const next = j + 1;
    if (next < w.s.length && !keep.has(w.s[j]!) && fits(next)) continue;
    out.s.push(w.s[j]!); out.left.push(w.left[j]!); out.right.push(w.right[j]!);
    last = j;
  }
  return out;
}

/** Sidewalk widths of every drivable way, computed once from one building set (street meshes, trees and metrics share them). */
export function allSidewalkWidths(roads: Road[], buildings: readonly BuildingRecord[]): Map<Road, SidewalkWidths> {
  const grid = buildingGrid(buildings);
  const out = new Map<Road, SidewalkWidths>();
  for (const r of roads) if (DRIVABLE.has(r.kind) && dedupe(r.points).length >= 2) out.set(r, sidewalkWidths(r, buildings, grid));
  return out;
}
