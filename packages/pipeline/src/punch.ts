import { inRing } from '@nn/shared';
import type { Pt } from './osm.js';

/** A mesh with any per-vertex attributes (positions x, y, z first). */
export type AttrMesh = { positions: Float32Array; indices: Uint32Array; uv: Float32Array; mark?: Float32Array; normals?: Float32Array };

/** Triangles near a hole are split until their edges are this short (m); the hole's edge is that ragged. */
const FINE = 0.25;

function ringDistance(ring: number[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j]!, az = ring[j + 1]!, ex = ring[i]! - ax, ez = ring[i + 1]! - az, l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return best;
}

/**
 * `m` without what lies inside the rings (holes in the ground: stairwells). Triangles crossing a ring's edge are split
 * (longest edge first, attributes interpolated) down to FINE and kept or dropped by their centroid. Returns `m` itself
 * if no triangle comes near a ring.
 */
export function punchMesh<T extends AttrMesh>(m: T, holes: Pt[][]): T {
  const rings = holes.map((h) => h.flatMap((p) => [p.x, p.z]));
  const boxes = rings.map((r) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]!); x1 = Math.max(x1, r[i]!); z0 = Math.min(z0, r[i + 1]!); z1 = Math.max(z1, r[i + 1]!); }
    return { x0, x1, z0, z1 };
  });
  const attrs: { src: Float32Array; size: number; out: number[] }[] = [{ src: m.positions, size: 3, out: [] }, { src: m.uv, size: 2, out: [] }];
  if (m.mark) attrs.push({ src: m.mark, size: 1, out: [] });
  if (m.normals) attrs.push({ src: m.normals, size: 3, out: [] });
  const P = attrs[0]!.out;
  let next = m.positions.length / 3;
  const X = (v: number) => (v < m.positions.length / 3 ? m.positions[v * 3]! : P[(v - m.positions.length / 3) * 3]!);
  const Z = (v: number) => (v < m.positions.length / 3 ? m.positions[v * 3 + 2]! : P[(v - m.positions.length / 3) * 3 + 2]!);
  const get = (a: { src: Float32Array; size: number; out: number[] }, v: number, k: number) =>
    v < m.positions.length / 3 ? a.src[v * a.size + k]! : a.out[(v - m.positions.length / 3) * a.size + k]!;
  const midpoint = (a: number, b: number): number => {
    for (const at of attrs) for (let k = 0; k < at.size; k++) at.out.push((get(at, a, k) + get(at, b, k)) / 2);
    return next++;
  };
  const idx: number[] = [];
  let touched = false;
  const stack: [number, number, number][] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    stack.push([m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!]);
    while (stack.length) {
      const [a, b, c] = stack.pop()!;
      const x0 = Math.min(X(a), X(b), X(c)), x1 = Math.max(X(a), X(b), X(c)), z0 = Math.min(Z(a), Z(b), Z(c)), z1 = Math.max(Z(a), Z(b), Z(c));
      const near = rings.filter((_, k) => { const bx = boxes[k]!; return x1 >= bx.x0 && x0 <= bx.x1 && z1 >= bx.z0 && z0 <= bx.z1; });
      if (near.length === 0) { idx.push(a, b, c); continue; }
      touched = true;
      const cx = (X(a) + X(b) + X(c)) / 3, cz = (Z(a) + Z(b) + Z(c)) / 3;
      const ab = Math.hypot(X(a) - X(b), Z(a) - Z(b)), bc = Math.hypot(X(b) - X(c), Z(b) - Z(c)), ca = Math.hypot(X(c) - X(a), Z(c) - Z(a));
      const longest = Math.max(ab, bc, ca);
      // clear of every edge (or small enough): the centroid decides
      if (longest <= FINE || near.every((r) => ringDistance(r, cx, cz) > longest)) {
        if (!near.some((r) => inRing(r, cx, cz))) idx.push(a, b, c);
        continue;
      }
      if (ab === longest) { const mid = midpoint(a, b); stack.push([a, mid, c], [mid, b, c]); }
      else if (bc === longest) { const mid = midpoint(b, c); stack.push([a, b, mid], [a, mid, c]); }
      else { const mid = midpoint(c, a); stack.push([a, b, mid], [mid, b, c]); }
    }
  }
  if (!touched) return m;
  const grow = (src: Float32Array, extra: number[]) => { const o = new Float32Array(src.length + extra.length); o.set(src); o.set(extra, src.length); return o; };
  const out = { ...m, positions: grow(m.positions, attrs[0]!.out), uv: grow(m.uv, attrs[1]!.out), indices: Uint32Array.from(idx) };
  let k = 2;
  if (m.mark) out.mark = grow(m.mark, attrs[k++]!.out);
  if (m.normals) out.normals = grow(m.normals, attrs[k++]!.out);
  return out;
}

/** A test for "(x, z) lies under a triangle of the mesh", with a grid over the triangles (cells of `cell` m). */
export function meshCovers(m: { positions: Float32Array; indices: Uint32Array }, cell = 8): (p: Pt) => boolean {
  const grid = new Map<string, number[]>();
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
    const x0 = Math.floor(Math.min(p[a]!, p[b]!, p[c]!) / cell), x1 = Math.floor(Math.max(p[a]!, p[b]!, p[c]!) / cell);
    const z0 = Math.floor(Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!) / cell), z1 = Math.floor(Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const key = `${gx}_${gz}`;
      let l = grid.get(key);
      if (!l) grid.set(key, (l = []));
      l.push(t);
    }
  }
  return ({ x, z }) => {
    for (const t of grid.get(`${Math.floor(x / cell)}_${Math.floor(z / cell)}`) ?? []) {
      const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
      const d1 = (x - p[b]!) * (p[a + 2]! - p[b + 2]!) - (p[a]! - p[b]!) * (z - p[b + 2]!);
      const d2 = (x - p[c]!) * (p[b + 2]! - p[c + 2]!) - (p[b]! - p[c]!) * (z - p[c + 2]!);
      const d3 = (x - p[a]!) * (p[c + 2]! - p[a + 2]!) - (p[c]! - p[a]!) * (z - p[a + 2]!);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
    }
    return false;
  };
}
