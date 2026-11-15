import { heightAt, type TerrainGrid } from '@nn/shared';
import type { Mesh } from './streets.js';

/**
 * Coarse terrain-following copy of a flat mesh (input y = offset above terrain), for collision: triangles are split
 * until no edge needs splitting, then every vertex gets y = offset + heightAt(x, z). An edge needs splitting if it is
 * longer than `maxEdge` in xz, or — with `tolerance` — if it is longer than `minEdge` and the terrain under it departs
 * more than `tolerance` from the straight edge (sampled at ¼, ½, ¾), so bends in the terrain get more vertices.
 *
 * Edges are cut at their midpoint, recursively; whether and where depends only on the edge, so neighbours sharing an
 * edge split it identically (no T-junctions). A triangle whose three edges all need splitting is bisected on its
 * longest one (shape-regular, so it terminates). Otherwise (a ribbon piece, a vertical kerb face) its two cut edges
 * are zipped together like a strip — O(length / maxEdge) pieces instead of the n² of a uniform subdivision — or, with
 * one cut edge, fanned from the opposite corner. Zip and fan pieces are then only bisected for length (> maxEdge):
 * the tolerance test is not hereditary (a piece may fail it where its parent edge passed), and applying it to the
 * thin interior slivers would never end. Winding and uv (interpolated) are kept.
 */
export function followTerrain(m: Mesh, t: TerrainGrid, maxEdge: number, tolerance = Infinity, minEdge = 0.5): Mesh {
  const pos = Array.from(m.positions, Number);
  const uv = Array.from(m.uv, Number);
  const idx: number[] = [];
  const mids = new Map<string, number>();
  const max2 = maxEdge * maxEdge;
  const len2 = (a: number, b: number) => (pos[a * 3]! - pos[b * 3]!) ** 2 + (pos[a * 3 + 2]! - pos[b * 3 + 2]!) ** 2;
  const min2 = minEdge * minEdge;
  const h = (x: number, z: number) => heightAt(t, x, z);
  /** The edge a–b has to be cut (see above). */
  const needs = (a: number, b: number): boolean => {
    if (a > b) [a, b] = [b, a]; // same answer from both sides of the edge, to the last bit
    const l = len2(a, b);
    if (l > max2) return true;
    if (tolerance === Infinity || l <= min2) return false;
    const ax = pos[a * 3]!, az = pos[a * 3 + 2]!, bx = pos[b * 3]!, bz = pos[b * 3 + 2]!;
    const ha = h(ax, az), hb = h(bx, bz);
    for (const f of [0.25, 0.5, 0.75]) {
      if (Math.abs(ha + f * (hb - ha) - h(ax + f * (bx - ax), az + f * (bz - az))) > tolerance) return true;
    }
    return false;
  };
  const mid = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let id = mids.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      for (let k = 0; k < 3; k++) pos.push((pos[a * 3 + k]! + pos[b * 3 + k]!) / 2);
      for (let k = 0; k < 2; k++) uv.push((uv[a * 2 + k]! + uv[b * 2 + k]!) / 2);
      mids.set(key, id);
    }
    return id;
  };
  /** Vertices strictly between a and b after cutting the edge until no piece needs splitting (a → b order). */
  const cuts = (a: number, b: number): number[] => {
    if (!needs(a, b)) return [];
    const p = mid(a, b);
    return [...cuts(a, p), p, ...cuts(p, b)];
  };
  type Tri = [number, number, number];
  /** Splits tri at the midpoint of edge k (tri[k] → tri[k+1]); both halves keep the winding. */
  const halve = (tri: Tri, k: number, out: Tri[]): void => {
    const [p, q, r] = [tri[k]!, tri[(k + 1) % 3]!, tri[(k + 2) % 3]!];
    const s = mid(p, q);
    out.push([p, s, r], [s, q, r]);
  };
  const longest = (e: number[]) => e.indexOf(Math.max(...e));
  /** Longest-edge bisection until no edge is longer than maxEdge. */
  const bisect = (tri: Tri): void => {
    const stack = [tri];
    while (stack.length) {
      const t3 = stack.pop()!;
      const e = [len2(t3[0], t3[1]), len2(t3[1], t3[2]), len2(t3[2], t3[0])];
      const k = longest(e);
      if (e[k]! > max2) halve(t3, k, stack);
      else idx.push(...t3);
    }
  };
  for (let i = 0; i < m.indices.length; i += 3) {
    const stack: Tri[] = [[m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!]];
    while (stack.length) {
      const tri = stack.pop()!;
      const split = [needs(tri[0], tri[1]), needs(tri[1], tri[2]), needs(tri[2], tri[0])];
      const n = split.filter(Boolean).length;
      if (n === 0) { idx.push(...tri); continue; }
      if (n === 3) { halve(tri, longest([len2(tri[0], tri[1]), len2(tri[1], tri[2]), len2(tri[2], tri[0])]), stack); continue; }
      if (n === 1) {
        // fan from the corner opposite the cut edge p → q
        const k = split.indexOf(true);
        const p = tri[k]!, q = tri[(k + 1) % 3]!, r = tri[(k + 2) % 3]!;
        const line = [p, ...cuts(p, q), q];
        for (let j = 0; j + 1 < line.length; j++) bisect([line[j]!, line[j + 1]!, r]);
        continue;
      }
      const short = split.indexOf(false);
      // thin: polygon from the apex O (opposite the edge that stays whole) along both cut edges, in the triangle's winding
      const o = tri[(short + 2) % 3]!, p = tri[short]!, q = tri[(short + 1) % 3]!; // edge p → q is the short one
      const L = [o, ...cuts(o, p), p, q, ...cuts(q, o)];
      const nl = L.length;
      // zip: (L0, L1, L[n−1]) then advance the side giving the shorter diagonal; vertices stay in cyclic order
      bisect([L[0]!, L[1]!, L[nl - 1]!]);
      let lo = 1, hi = nl - 1;
      while (hi - lo > 1) {
        if (len2(L[lo + 1]!, L[hi]!) <= len2(L[lo]!, L[hi - 1]!)) { bisect([L[lo]!, L[lo + 1]!, L[hi]!]); lo++; }
        else { bisect([L[lo]!, L[hi - 1]!, L[hi]!]); hi--; }
      }
    }
  }
  const out = Float32Array.from(pos);
  for (let v = 0; v < out.length / 3; v++) out[v * 3 + 1] = pos[v * 3 + 1]! + h(pos[v * 3]!, pos[v * 3 + 2]!);
  return { positions: out, uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

/**
 * How far the coarse surface of a followTerrain mesh departs from the exact drape (offset + heightAt): sampled at the
 * centroid and edge midpoints of every non-vertical triangle. Because the offset is linear across a triangle, the
 * deviation there is |Σ wᵢ·heightAt(vᵢ) − heightAt(p)| and needs no knowledge of the offsets.
 */
export function followDeviation(m: Mesh, t: TerrainGrid): { max: number; p99: number; samples: number } {
  const P = m.positions;
  const devs: number[] = [];
  const W = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]] as const;
  for (let i = 0; i < m.indices.length; i += 3) {
    const v = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!].map((n) => ({ x: P[n * 3]!, z: P[n * 3 + 2]! }));
    const [a, b, c] = v as [{ x: number; z: number }, { x: number; z: number }, { x: number; z: number }];
    if (Math.abs((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)) < 1e-9) continue; // vertical face
    const h = v.map((p) => heightAt(t, p.x, p.z));
    for (const w of W) {
      const x = w[0] * a.x + w[1] * b.x + w[2] * c.x, z = w[0] * a.z + w[1] * b.z + w[2] * c.z;
      devs.push(Math.abs(w[0] * h[0]! + w[1] * h[1]! + w[2] * h[2]! - heightAt(t, x, z)));
    }
  }
  devs.sort((p, q) => p - q);
  return { max: devs.at(-1) ?? 0, p99: devs[Math.floor(devs.length * 0.99)] ?? 0, samples: devs.length };
}
