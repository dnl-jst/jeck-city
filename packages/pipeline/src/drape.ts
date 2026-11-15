import { heightAt, TERRAIN_DIAGONAL, type TerrainGrid } from '@nn/shared';
import type { Mesh } from './streets.js';

/** Triangles with less xz area are treated as vertical (kerb faces). */
const FLAT_MIN_AREA = 1e-6;
/** Fan triangles with less (doubled) area are clipping slivers and dropped. */
const SLIVER = 1e-12;

/**
 * Clip vertex. `off` is the input y (offset above terrain). `mask` marks which edges of the source triangle the point
 * lies on (bit e = edge from vertex e to vertex (e+1)%3); 0 = interior.
 */
type CV = { x: number; z: number; off: number; u: number; v: number; mask: number };

/** A clip line `f(x, z) = 0`: grid line x = k, grid line z = k, or a cell diagonal ('d', k unused). */
type Line = { kind: 'x' | 'z' | 'd'; f: (x: number, z: number) => number; k: number };

/** Draped vertex source: position in xz, offset above terrain, uv. */
type Src = { x: number; z: number; off: number; u: number; v: number };

class Out {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** Welds bit-identical vertices within one source triangle (cleared per triangle by `begin`). */
  private weld = new Map<string, number>();
  constructor(private t: TerrainGrid) {}
  begin(): void {
    this.weld.clear();
  }
  vert(p: Src): number {
    const key = `${p.x},${p.z},${p.off},${p.u},${p.v}`;
    let id = this.weld.get(key);
    if (id === undefined) {
      id = this.pos.length / 3;
      this.pos.push(p.x, p.off + heightAt(this.t, p.x, p.z), p.z);
      this.uv.push(p.u, p.v);
      this.weld.set(key, id);
    }
    return id;
  }
  build(): Mesh {
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx), uv: Float32Array.from(this.uv) };
  }
}

/** Canonical order: smaller (x, z) first, so both triangles sharing an edge compute identical crossings. */
const before = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x < b.x || (a.x === b.x && a.z < b.z);

/**
 * Lays a mesh onto the terrain triangulation: every output triangle lies within one terrain triangle (cell half per
 * TERRAIN_DIAGONAL), y = input y (offset) + terrain height. uv is interpolated and each input triangle's winding kept.
 * Horizontal triangles are clipped against cell edges and diagonals; vertical ones (zero xz area, e.g. kerb faces)
 * are cut into slabs wherever their xz trace crosses a grid line or diagonal.
 */
export function drapeMesh(m: Mesh, t: TerrainGrid): Mesh {
  if (m.mark) return drapeMarked(m, m.mark, t);
  const out = new Out(t);
  const P = m.positions;
  for (let i = 0; i < m.indices.length; i += 3) {
    const tri: CV[] = [0, 1, 2].map((k) => {
      const n = m.indices[i + k]!;
      return { x: P[n * 3]!, off: P[n * 3 + 1]!, z: P[n * 3 + 2]!, u: m.uv[n * 2]!, v: m.uv[n * 2 + 1]!, mask: k === 0 ? 0b101 : k === 1 ? 0b011 : 0b110 };
    });
    const [a, b, c] = tri as [CV, CV, CV];
    out.begin();
    const area2 = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (Math.abs(area2) / 2 >= FLAT_MIN_AREA) drapeFlat(tri, area2, t, out);
    else drapeVertical(tri, t, out);
  }
  return out.build();
}

/**
 * `mark` is constant per triangle (markings: per strip or quad), so each mark value is draped on its own and the
 * pieces are concatenated with that value on every output vertex.
 */
function drapeMarked(m: Mesh, mark: Float32Array, t: TerrainGrid): Mesh {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < m.indices.length; i += 3) {
    const v = mark[m.indices[i]!]!;
    let g = groups.get(v);
    if (!g) groups.set(v, (g = []));
    g.push(m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!);
  }
  const parts: { v: number; d: Mesh }[] = [];
  for (const [v, idx] of groups) parts.push({ v, d: drapeMesh({ positions: m.positions, uv: m.uv, indices: Uint32Array.from(idx) }, t) });
  const nv = parts.reduce((s, p) => s + p.d.positions.length / 3, 0);
  const ni = parts.reduce((s, p) => s + p.d.indices.length, 0);
  const out: Mesh = { positions: new Float32Array(nv * 3), uv: new Float32Array(nv * 2), indices: new Uint32Array(ni), mark: new Float32Array(nv) };
  let vo = 0, io = 0;
  for (const { v, d } of parts) {
    out.positions.set(d.positions, vo * 3);
    out.uv.set(d.uv, vo * 2);
    out.mark!.fill(v, vo, vo + d.positions.length / 3);
    for (let k = 0; k < d.indices.length; k++) out.indices[io + k] = d.indices[k]! + vo;
    vo += d.positions.length / 3;
    io += d.indices.length;
  }
  return out;
}

function lerp(p: CV, q: CV, s: number, x: number, z: number, mask: number): CV {
  return { x, z, off: p.off + s * (q.off - p.off), u: p.u + s * (q.u - p.u), v: p.v + s * (q.v - p.v), mask };
}

function drapeFlat(tri: CV[], area2: number, t: TerrainGrid, out: Out): void {
  const [a, b, c] = tri as [CV, CV, CV];
  const bary = (x: number, z: number, mask: number): CV => {
    const wb = ((x - a.x) * (c.z - a.z) - (z - a.z) * (c.x - a.x)) / -area2;
    const wc = ((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) / -area2;
    const wa = 1 - wb - wc;
    return { x, z, off: wa * a.off + wb * b.off + wc * c.off, u: wa * a.u + wb * b.u + wc * c.u, v: wa * a.v + wb * b.v + wc * c.v, mask };
  };

  /** Crossing of segment p→q (both inside the source triangle) with line L. */
  const cross = (p: CV, q: CV, L: Line): CV => {
    const common = p.mask & q.mask;
    if (common) {
      // Both on source edge e: compute from the edge's endpoints only, in canonical order.
      const e = common & 1 ? 0 : common & 2 ? 1 : 2;
      let E0 = tri[e]!;
      let E1 = tri[(e + 1) % 3]!;
      if (before(E1, E0)) [E0, E1] = [E1, E0];
      const f0 = L.f(E0.x, E0.z);
      const f1 = L.f(E1.x, E1.z);
      // Guard: an edge (numerically) along the line has no proper crossing; keep p.
      if (f0 === f1) return p;
      // Keep the crossing within p→q even if rounding put it slightly outside (only matters in degenerate cases).
      const alongX = Math.abs(E1.x - E0.x) >= Math.abs(E1.z - E0.z);
      const param = (r: CV) => (alongX ? (r.x - E0.x) / (E1.x - E0.x) : (r.z - E0.z) / (E1.z - E0.z));
      const sp = param(p);
      const sq = param(q);
      const s = Math.min(Math.max(f0 / (f0 - f1), Math.min(sp, sq)), Math.max(sp, sq));
      if (!Number.isFinite(s)) return p;
      const x = L.kind === 'x' ? L.k : E0.x + s * (E1.x - E0.x);
      const z = L.kind === 'z' ? L.k : E0.z + s * (E1.z - E0.z);
      return lerp(E0, E1, s, x, z, 1 << e);
    }
    if (before(q, p)) [p, q] = [q, p];
    let x: number;
    let z: number;
    if (L.kind === 'x') {
      x = L.k;
      z = p.z + ((x - p.x) / (q.x - p.x)) * (q.z - p.z);
    } else if (L.kind === 'z') {
      z = L.k;
      x = p.x + ((z - p.z) / (q.z - p.z)) * (q.x - p.x);
    } else {
      // Diagonals are clipped after the cell bounds, and the diagonal meets the cell boundary only at corners (where f
      // is 0, never a strict sign change), so p→q is never a boundary segment here.
      const fp = L.f(p.x, p.z);
      const s = fp / (fp - L.f(q.x, q.z));
      x = p.x + s * (q.x - p.x);
      z = p.z + s * (q.z - p.z);
    }
    return bary(x, z, 0);
  };

  /** Sutherland–Hodgman: keeps the part with sign·f ≤ 0; preserves vertex order (winding). */
  const clip = (poly: CV[], L: Line, sign: number): CV[] => {
    const res: CV[] = [];
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!;
      const q = poly[(k + 1) % poly.length]!;
      const fp = sign * L.f(p.x, p.z);
      const fq = sign * L.f(q.x, q.z);
      if (fp <= 0) res.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) res.push(cross(p, q, L));
    }
    return res;
  };

  const emit = (poly: CV[]) => {
    if (poly.length < 3) return;
    const p0 = poly[0]!;
    for (let k = 1; k + 1 < poly.length; k++) {
      const p1 = poly[k]!;
      const p2 = poly[k + 1]!;
      const ar = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
      if (ar * Math.sign(area2) <= SLIVER) continue;
      out.idx.push(out.vert(p0), out.vert(p1), out.vert(p2));
    }
  };

  const minX = Math.min(a.x, b.x, c.x);
  const maxX = Math.max(a.x, b.x, c.x);
  const c0 = Math.floor(minX - t.x0);
  const c1 = Math.max(c0, Math.ceil(maxX - t.x0) - 1);
  for (let ci = c0; ci <= c1; ci++) {
    const X = t.x0 + ci;
    const X1 = t.x0 + ci + 1;
    let col = clip(tri, { kind: 'x', k: X, f: (x) => X - x }, 1);
    col = clip(col, { kind: 'x', k: X1, f: (x) => x - X1 }, 1);
    if (col.length < 3) continue;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of col) {
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const r0 = Math.floor(minZ - t.z0);
    const r1 = Math.max(r0, Math.ceil(maxZ - t.z0) - 1);
    for (let ri = r0; ri <= r1; ri++) {
      const Z = t.z0 + ri;
      const Z1 = t.z0 + ri + 1;
      let cell = clip(col, { kind: 'z', k: Z, f: (_x, z) => Z - z }, 1);
      cell = clip(cell, { kind: 'z', k: Z1, f: (_x, z) => z - Z1 }, 1);
      if (cell.length < 3) continue;
      const diag: Line =
        TERRAIN_DIAGONAL === 'x1z0-x0z1'
          ? { kind: 'd', k: 0, f: (x, z) => x - X + (z - Z) - 1 }
          : { kind: 'd', k: 0, f: (x, z) => z - Z - (x - X) };
      emit(clip(cell, diag, 1));
      emit(clip(cell, diag, -1));
    }
  }
}

/** Point of a vertical triangle in its plane: s along the xz trace A→B, y = offset. */
type SV = { s: number; x: number; z: number; off: number; u: number; v: number };

function drapeVertical(tri: CV[], t: TerrainGrid, out: Out): void {
  // Trace endpoints: the two vertices farthest apart in xz, canonically ordered.
  let best = -1;
  let A = tri[0]!;
  let B = tri[1]!;
  for (let k = 0; k < 3; k++) {
    const p = tri[k]!;
    const q = tri[(k + 1) % 3]!;
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d > best) [best, A, B] = [d, p, q];
  }
  if (before(B, A)) [A, B] = [B, A];
  const dx = B.x - A.x;
  const dz = B.z - A.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) {
    out.idx.push(...tri.map((p) => out.vert(p)));
    return;
  }
  const poly: SV[] = tri.map((p) => ({ s: ((p.x - A.x) * dx + (p.z - A.z) * dz) / len2, x: p.x, z: p.z, off: p.off, u: p.u, v: p.v }));

  // Parameters along A→B where the trace crosses grid lines or diagonals.
  const cuts: number[] = [];
  const addCrossings = (ga: number, gb: number) => {
    if (ga === gb) return;
    for (let k = Math.ceil(Math.min(ga, gb)); k <= Math.floor(Math.max(ga, gb)); k++) {
      const s = (k - ga) / (gb - ga);
      if (s > 0 && s < 1) cuts.push(s);
    }
  };
  const lx = (p: CV) => p.x - t.x0;
  const lz = (p: CV) => p.z - t.z0;
  addCrossings(lx(A), lx(B));
  addCrossings(lz(A), lz(B));
  if (TERRAIN_DIAGONAL === 'x1z0-x0z1') addCrossings(lx(A) + lz(A), lx(B) + lz(B));
  else addCrossings(lz(A) - lx(A), lz(B) - lx(B));
  cuts.sort((p, q) => p - q);
  const smin = Math.min(...poly.map((p) => p.s));
  const smax = Math.max(...poly.map((p) => p.s));
  const bounds = [smin, ...cuts.filter((s, k) => s > smin && s < smax && (k === 0 || s - cuts[k - 1]! > 1e-12)), smax];

  const at = (p: SV, q: SV, s: number): SV => {
    if (q.s < p.s || (q.s === p.s && q.off < p.off)) [p, q] = [q, p];
    const w = (s - p.s) / (q.s - p.s);
    return { s, x: A.x + s * dx, z: A.z + s * dz, off: p.off + w * (q.off - p.off), u: p.u + w * (q.u - p.u), v: p.v + w * (q.v - p.v) };
  };
  const clip = (pl: SV[], s0: number, sign: number): SV[] => {
    const res: SV[] = [];
    for (let k = 0; k < pl.length; k++) {
      const p = pl[k]!;
      const q = pl[(k + 1) % pl.length]!;
      const fp = sign * (p.s - s0);
      const fq = sign * (q.s - s0);
      if (fp <= 0) res.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) res.push(at(p, q, s0));
    }
    return res;
  };
  for (let k = 0; k + 1 < bounds.length; k++) {
    const slab = clip(clip(poly, bounds[k]!, -1), bounds[k + 1]!, 1);
    if (slab.length < 3) continue;
    const p0 = slab[0]!;
    for (let j = 1; j + 1 < slab.length; j++) {
      const p1 = slab[j]!;
      const p2 = slab[j + 1]!;
      const ar = (p1.s - p0.s) * (p2.off - p0.off) - (p1.off - p0.off) * (p2.s - p0.s);
      if (Math.abs(ar) * Math.sqrt(len2) <= SLIVER) continue;
      out.idx.push(out.vert(p0), out.vert(p1), out.vert(p2));
    }
  }
}
