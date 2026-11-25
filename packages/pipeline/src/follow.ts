import { heightAt, TERRAIN_DIAGONAL, type TerrainGrid } from '@nn/shared';
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
 * thin interior slivers would never end.
 *
 * Then, with `tolerance`, a 2D-adaptive pass in rounds: every triangle whose surface departs more than `tolerance`
 * from the exact drape (triangleDeviation, the true maximum over the triangle) and whose longest edge exceeds
 * `minEdge` marks that longest edge. Closure: a triangle with any marked edge also marks its longest edge. Every
 * triangle then bisects its marked edges at their midpoints (longest first). A marked edge is split by every
 * triangle that has it, so the mesh stays crack-free; the decision about an edge is global, never per side.
 *
 * Input vertices are welded by position first, so neighbouring input triangles share their edges. Winding and uv
 * (interpolated; of the first welded vertex) are kept.
 */
export function followTerrain(m: Mesh, t: TerrainGrid, maxEdge: number, tolerance = Infinity, minEdge = 0.5): Mesh {
  // weld by position, so edges shared by input triangles are recognised as shared
  const pos: number[] = [], uv: number[] = [];
  const weld = new Map<string, number>();
  const remap = new Uint32Array(m.positions.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const key = `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      pos.push(m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!);
      uv.push(m.uv[v * 2]!, m.uv[v * 2 + 1]!);
      weld.set(key, id);
    }
    remap[v] = id;
  }
  const idx = new Triangles();
  const mids = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? a * KEY + b : b * KEY + a);
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
    const key = ek(a, b);
    let id = mids.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      if (id >= KEY) throw new Error(`followTerrain: more than ${KEY} vertices, edge keys would collide`);
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
      else idx.push(t3[0], t3[1], t3[2]);
    }
  };
  for (let i = 0; i < m.indices.length; i += 3) {
    const stack: Tri[] = [[remap[m.indices[i]!]!, remap[m.indices[i + 1]!]!, remap[m.indices[i + 2]!]!]];
    while (stack.length) {
      const tri = stack.pop()!;
      const split = [needs(tri[0], tri[1]), needs(tri[1], tri[2]), needs(tri[2], tri[0])];
      const n = split.filter(Boolean).length;
      if (n === 0) { idx.push(tri[0], tri[1], tri[2]); continue; }
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
      const op = cuts(o, p);
      const L = [o, ...op, p, q, ...cuts(q, o)];
      const nl = L.length, ip = op.length + 1; // L[ip] = p, L[ip + 1] = q
      // zip: (L0, L1, L[n−1]) then advance the side giving the shorter diagonal; vertices stay in cyclic order. Each
      // pointer stops at the end of its own rail (lo at p, hi at q): past it, all three corners would lie on one line.
      bisect([L[0]!, L[1]!, L[nl - 1]!]);
      let lo = 1, hi = nl - 1;
      while (hi - lo > 1) {
        const canLo = lo < ip, canHi = hi > ip + 1;
        if (canLo && (!canHi || len2(L[lo + 1]!, L[hi]!) <= len2(L[lo]!, L[hi - 1]!))) { bisect([L[lo]!, L[lo + 1]!, L[hi]!]); lo++; }
        else { bisect([L[lo]!, L[hi - 1]!, L[hi]!]); hi--; }
      }
    }
  }

  const tris = tolerance === Infinity ? idx.done() : refine(idx.done());
  const out = Float32Array.from(pos);
  for (let v = 0; v < out.length / 3; v++) out[v * 3 + 1] = pos[v * 3 + 1]! + h(pos[v * 3]!, pos[v * 3 + 2]!);
  return { positions: out, uv: Float32Array.from(uv), indices: tris };

  /**
   * The 2D-adaptive rounds (see above), on flat vertex triples: millions of triangles, so no object per triangle (the
   * per-round garbage of those set the pipeline's peak memory).
   */
  function refine(start: Uint32Array): Uint32Array {
    const hv = (v: number) => h(pos[v * 3]!, pos[v * 3 + 2]!);
    const dev = (a: number, b: number, c: number) => triangleDeviation(t, pos[a * 3]!, pos[a * 3 + 2]!, hv(a), pos[b * 3]!, pos[b * 3 + 2]!, hv(b), pos[c * 3]!, pos[c * 3 + 2]!, hv(c)).dev;
    // the edges of triangle (a, b, c): k = 0: a → b, 1: b → c, 2: c → a
    const ends = (tri: ArrayLike<number>, o: number, k: number): [number, number] => [tri[o + k]!, tri[o + ((k + 1) % 3)]!];
    /** Of the edges k (in k order) of the triangle at o that pass `use`, the first longest; -1 if none passes. */
    const longestEdge = (tri: ArrayLike<number>, o: number, use: (key: number) => boolean): number => {
      let best = -1, bestL = -Infinity;
      for (let k = 0; k < 3; k++) {
        const [p, q] = ends(tri, o, k);
        if (!use(ek(p, q))) continue;
        const l = len2(p, q);
        if (l > bestL) { best = k; bestL = l; }
      }
      return best;
    };
    const any = () => true;
    let cur = start, ok = new Uint8Array(start.length / 3);
    for (let round = 0; round < 40; round++) {
      const marked = new Set<number>();
      const isMarked = (key: number) => marked.has(key);
      for (let c = 0; c < ok.length; c++) {
        if (ok[c]) continue;
        const o = c * 3, k = longestEdge(cur, o, any);
        const [p, q] = ends(cur, o, k);
        if (len2(p, q) > min2 && dev(cur[o]!, cur[o + 1]!, cur[o + 2]!) > tolerance) marked.add(ek(p, q));
        else ok[c] = 1; // stays ok until it is split
      }
      if (!marked.size) break;
      // closure: whoever has a marked edge splits its longest edge first
      for (let changed = true; changed;) {
        changed = false;
        for (let o = 0; o < cur.length; o += 3) {
          if (longestEdge(cur, o, isMarked) < 0) continue;
          const [p, q] = ends(cur, o, longestEdge(cur, o, any));
          if (!marked.has(ek(p, q))) { marked.add(ek(p, q)); changed = true; }
        }
      }
      const next = new Triangles(), nextOk: number[] = [];
      const stack: number[] = [];
      for (let c = 0; c < ok.length; c++) {
        stack.push(cur[c * 3]!, cur[c * 3 + 1]!, cur[c * 3 + 2]!);
        let split = false;
        while (stack.length) {
          const o = stack.length - 3, k = longestEdge(stack, o, isMarked);
          if (k < 0) {
            next.push(stack[o]!, stack[o + 1]!, stack[o + 2]!);
            nextOk.push(ok[c] && !split ? 1 : 0);
            stack.length = o;
            continue;
          }
          split = true;
          // halve at edge k: [p, s, r] below [s, q, r], so [s, q, r] is taken first
          const p = stack[o + k]!, q = stack[o + ((k + 1) % 3)]!, r = stack[o + ((k + 2) % 3)]!;
          const m = mid(p, q);
          stack.length = o;
          stack.push(p, m, r, m, q, r);
        }
      }
      cur = next.done();
      ok = Uint8Array.from(nextOk);
    }
    return cur;
  }
}

/** A growing list of vertex triples. */
class Triangles {
  private a = new Uint32Array(3 * 1024);
  private n = 0;
  push(p: number, q: number, r: number): void {
    if (this.n + 3 > this.a.length) {
      const a = new Uint32Array(this.a.length * 2);
      a.set(this.a);
      this.a = a;
    }
    this.a[this.n++] = p;
    this.a[this.n++] = q;
    this.a[this.n++] = r;
  }
  done(): Uint32Array {
    return this.a.slice(0, this.n);
  }
}

/** Triangles narrower than this (m) in xz count as vertical. */
const VERTICAL_WIDTH = 1e-3;

/** Vertex-pair key factor for edge maps (numbers, not strings: millions of edges). */
const KEY = 1 << 22;

/**
 * Exact maximum of |plane − terrain| over the triangle, where the plane interpolates the terrain heights ha, hb, hc at
 * its corners: terrain and plane are both linear on every piece of the overlay of the triangle with the terrain
 * triangulation, so the maximum sits at a grid point inside the triangle or where an edge crosses a grid line or cell
 * diagonal. 0 for vertical triangles (narrower than VERTICAL_WIDTH in xz: kerb faces, whose corners float32 rounding
 * moves off their common line — the plane through them would be meaningless). Returns the worst point too.
 */
export function triangleDeviation(t: TerrainGrid, ax: number, az: number, ha: number, bx: number, bz: number, hb: number, cx: number, cz: number, hc: number): { dev: number; x: number; z: number } {
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  let best = { dev: 0, x: ax, z: az };
  const long = Math.sqrt(Math.max((ax - bx) ** 2 + (az - bz) ** 2, (bx - cx) ** 2 + (bz - cz) ** 2, (cx - ax) ** 2 + (cz - az) ** 2));
  if (Math.abs(d) <= VERTICAL_WIDTH * long) return best; // |d| = 2·area = width · longest edge
  const at = (x: number, z: number, plane: number) => {
    const e = Math.abs(plane - heightAt(t, x, z));
    if (e > best.dev) best = { dev: e, x, z };
  };
  for (let x = Math.ceil(Math.min(ax, bx, cx)); x <= Math.floor(Math.max(ax, bx, cx)); x++) {
    for (let z = Math.ceil(Math.min(az, bz, cz)); z <= Math.floor(Math.max(az, bz, cz)); z++) {
      const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-9 && w1 >= -1e-9 && w2 >= -1e-9) at(x, z, w0 * ha + w1 * hb + w2 * hc);
    }
  }
  const diag = TERRAIN_DIAGONAL === 'x1z0-x0z1' ? 1 : -1; // diagonals lie on x + z = k, or x − z = k
  for (const [px, pz, ph, qx, qz, qh] of [[ax, az, ha, bx, bz, hb], [bx, bz, hb, cx, cz, hc], [cx, cz, hc, ax, az, ha]] as const) {
    const cross = (p: number, q: number) => {
      if (p === q) return;
      for (let k = Math.ceil(Math.min(p, q)); k <= Math.floor(Math.max(p, q)); k++) {
        const f = (k - p) / (q - p);
        at(px + f * (qx - px), pz + f * (qz - pz), ph + f * (qh - ph));
      }
    };
    cross(px, qx);
    cross(pz, qz);
    cross(px + diag * pz, qx + diag * qz);
  }
  return best;
}

/**
 * How far the surface of a followTerrain mesh departs from the exact drape (offset + heightAt): the exact maximum per
 * non-vertical triangle (see triangleDeviation; the offset is linear across a triangle, so only terrain heights
 * matter). max, 99th percentile over triangles, and where the maximum is.
 */
export function followDeviation(m: Mesh, t: TerrainGrid): { max: number; p99: number; triangles: number; at: { x: number; z: number } } {
  const P = m.positions;
  const devs: number[] = [];
  let worst = { dev: 0, x: 0, z: 0 };
  const v = (n: number) => [P[n * 3]!, P[n * 3 + 2]!, heightAt(t, P[n * 3]!, P[n * 3 + 2]!)] as const;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [v(m.indices[i]!), v(m.indices[i + 1]!), v(m.indices[i + 2]!)];
    const d = triangleDeviation(t, ...a, ...b, ...c);
    const l = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
    if (Math.abs((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1])) <= VERTICAL_WIDTH * l) continue; // vertical face
    devs.push(d.dev);
    if (d.dev > worst.dev) worst = d;
  }
  devs.sort((p, q) => p - q);
  return { max: worst.dev, p99: devs[Math.floor(devs.length * 0.99)] ?? 0, triangles: devs.length, at: { x: worst.x, z: worst.z } };
}
