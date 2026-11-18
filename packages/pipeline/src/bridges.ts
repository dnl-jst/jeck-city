import { heightAt, type TerrainGrid } from '@nn/shared';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { ptKey } from './polyline.js';
import type { Mesh } from './streets.js';
import { WATER_DEPTH, type Water } from './water.js';

/**
 * Bridges over the water (the Rhine bridges). DGM1 has no bridges, so a draped bridge would lie on the water. Every
 * bridge=* way, tram track or railway on a bridge that is connected (shared nodes) to one over the water belongs to a
 * deck: its height is fixed at the free ends (where the bridge meets the ground: the terrain there) and interpolated
 * linearly in between along the ways (harmonic on the way graph), plus an arch where that leaves less than CLEARANCE
 * above the water. Decks within CLUSTER of each other form one structure (carriageways, paths and tracks of one bridge),
 * which gets a slab under its decks, parapets along its edges and piers in the water.
 */

/**
 * Deck surface at least this far above the water level (m) over the middle half of the water span (the fairway; the
 * decks meet the quays lower). Spans shorter than SHORT_SPAN (harbour footbridges) need only SHORT_CLEARANCE.
 */
export const CLEARANCE = 9;
const SHORT_SPAN = 60;
const SHORT_CLEARANCE = 3;
/** Ways of a structure follow its axis profile from this far (graph distance, m) from their free ends. */
const BLEND = 40;
/** The arch runs this far beyond the water on both sides. */
const ARCH_MARGIN = 25;
/** Bridge groups this close (m) are one structure. */
const CLUSTER = 30;
/** Structure profile bins along its axis (m). */
const BIN = 2;
/** Slab top below the lowest deck surface in a bin, and the slab thickness. */
const SLAB_GAP = 0.08;
const SLAB_DEPTH = 2.2;
const PARAPET_H = 1.1;
const PARAPET_W = 0.3;
/** Parapets only where the deck is this far above the ground (not at the abutments where side ways join). */
const PARAPET_MIN_RISE = 1.2;
/** About one pier per this many metres of water. */
const PIER_SPACING = 150;
const PIER_LEN = 4;
/** Piers stop this far inside the slab edges. */
const PIER_INSET = 1.5;

type Seg = { a: number; b: number; len: number };
type Group = { nodes: number[]; segs: Seg[] };
export type Structure = {
  axis: Pt[];
  cum: number[];
  /** Arc length range of its nodes on the axis. */
  s0: number;
  s1: number;
  /** Water span on the axis ([NaN, NaN] if none). */
  w0: number;
  w1: number;
  meanLevel: number;
  /** Profile per BIN from s0 (filled by bridgeBodies): lateral edges (left < right, metres right of the axis) and slab top. */
  left: number[];
  right: number[];
  top: number[];
};

export type BridgePlan = {
  roads: Set<Road>;
  tracks: Set<Pt[]>;
  rails: Pt[][];
  structures: Structure[];
  /** Node positions and deck heights (local y). */
  pos: Pt[];
  h: number[];
  /** Segments of all decks with their structure. */
  segs: (Seg & { st: number })[];
  /** Segment indices by GRID cell (segments within GRID_REACH of the cell). */
  grid: Map<string, number[]>;
};

const GRID = 25;
const GRID_REACH = 40;
const cellKey = (cx: number, cz: number) => `${cx},${cz}`;

type Proj = { s: number; lat: number; dir: Pt };

/** Closest point of polyline `pts` (arc lengths `cum`) to p: arc length, signed lateral offset (+ = right of travel), direction. */
export function project(pts: Pt[], cum: number[], p: Pt): Proj {
  let best = { d: Infinity, s: 0, lat: 0, dir: { x: 1, z: 0 } };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    if (l2 === 0) continue;
    const u = Math.min(1, Math.max(0, ((p.x - a.x) * ex + (p.z - a.z) * ez) / l2));
    const qx = a.x + ex * u, qz = a.z + ez * u;
    const d = Math.hypot(p.x - qx, p.z - qz);
    if (d < best.d) {
      const l = Math.sqrt(l2);
      const dir = { x: ex / l, z: ez / l };
      // right of travel in x/z seen from above (y up, z south): (−dir.z, dir.x)
      const lat = (p.x - qx) * -dir.z + (p.z - qz) * dir.x;
      best = { d, s: cum[i - 1]! + l * u, lat, dir };
    }
  }
  return { s: best.s, lat: best.lat, dir: best.dir };
}

function cumulative(pts: Pt[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z));
  return c;
}

function pointAt(pts: Pt[], cum: number[], s: number): { p: Pt; dir: Pt } {
  let i = 1;
  while (i < pts.length - 1 && cum[i]! < s) i++;
  const a = pts[i - 1]!, b = pts[i]!, l = cum[i]! - cum[i - 1]! || 1;
  const u = (s - cum[i - 1]!) / l; // may extrapolate beyond the ends
  return { p: { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }, dir: { x: (b.x - a.x) / l, z: (b.z - a.z) / l } };
}

function isWater(t: TerrainGrid, w: Water, p: Pt): number | undefined {
  const c = Math.round(p.x - t.x0), r = Math.round(p.z - t.z0);
  if (c < 0 || r < 0 || c >= t.cols || r >= t.rows) return undefined;
  const i = r * t.cols + c;
  return w.mask[i] ? w.level[i]! : undefined;
}

/**
 * Deck height at a free end: the highest terrain within ABUTMENT_R. Bridge ways often end right at the edge of a quay
 * wall, which the (blurred) DGM turns into a slope down to the water; the deck continues the upper level.
 */
const ABUTMENT_R = 6;
function abutment(t: TerrainGrid, p: Pt): number {
  let h = -Infinity;
  for (let dz = -ABUTMENT_R; dz <= ABUTMENT_R; dz++) {
    for (let dx = -ABUTMENT_R; dx <= ABUTMENT_R; dx++) if (dx * dx + dz * dz <= ABUTMENT_R * ABUTMENT_R) h = Math.max(h, heightAt(t, p.x + dx, p.z + dz));
  }
  return h;
}

/** Finds the bridges over the water and their deck heights. */
export function planBridges(f: OsmFeatures, t: TerrainGrid, w: Water): BridgePlan {
  type El = { pts: Pt[]; road?: Road; track?: Pt[]; rail?: Pt[] };
  const els: El[] = [
    ...f.roads.filter((r) => r.bridge).map((r) => ({ pts: r.points, road: r })),
    ...f.bridgeTracks.map((p) => ({ pts: p, track: p })),
    ...f.railBridges.map((p) => ({ pts: p, rail: p })),
  ];
  // the way graph: nodes by position
  const pos: Pt[] = [];
  const ids = new Map<string, number>();
  const node = (p: Pt) => {
    const k = ptKey(p);
    let i = ids.get(k);
    if (i === undefined) ids.set(k, (i = pos.push(p) - 1));
    return i;
  };
  const elNodes = els.map((e) => e.pts.map(node));
  const parent = pos.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const ns of elNodes) for (let k = 1; k < ns.length; k++) parent[find(ns[k]!)] = find(ns[0]!);
  const byRoot = new Map<number, { els: number[] }>();
  elNodes.forEach((ns, e) => {
    const r = find(ns[0]!);
    if (!byRoot.has(r)) byRoot.set(r, { els: [] });
    byRoot.get(r)!.els.push(e);
  });
  // groups over the water
  const groups: (Group & { els: number[] })[] = [];
  for (const { els: es } of byRoot.values()) {
    const wet = es.some((e) => els[e]!.pts.some((p) => isWater(t, w, p) !== undefined));
    if (!wet) continue;
    const nodes = [...new Set(es.flatMap((e) => elNodes[e]!))];
    const segs: Seg[] = [];
    for (const e of es) {
      const ns = elNodes[e]!;
      for (let k = 1; k < ns.length; k++) if (ns[k] !== ns[k - 1]) segs.push({ a: ns[k - 1]!, b: ns[k]!, len: Math.max(0.01, Math.hypot(pos[ns[k]!]!.x - pos[ns[k - 1]!]!.x, pos[ns[k]!]!.z - pos[ns[k - 1]!]!.z)) });
    }
    groups.push({ nodes, segs, els: es });
  }

  // heights: fixed at the free ends on land, harmonic (linear along the ways) in between
  const h = new Array<number>(pos.length).fill(NaN);
  /** Graph distance (m) to the nearest free end of its group. */
  const toEnd = new Array<number>(pos.length).fill(Infinity);
  const kept: typeof groups = [];
  for (const g of groups) {
    const adj = new Map<number, { j: number; wgt: number }[]>();
    for (const s of g.segs) {
      adj.set(s.a, [...(adj.get(s.a) ?? []), { j: s.b, wgt: 1 / s.len }]);
      adj.set(s.b, [...(adj.get(s.b) ?? []), { j: s.a, wgt: 1 / s.len }]);
    }
    const fixed = new Set(g.nodes.filter((n) => (adj.get(n)?.length ?? 0) === 1 && isWater(t, w, pos[n]!) === undefined));
    if (!fixed.size) continue;
    for (const n of fixed) h[n] = abutment(t, pos[n]!);
    const mean = [...fixed].reduce((s, n) => s + h[n]!, 0) / fixed.size;
    const free = g.nodes.filter((n) => !fixed.has(n));
    for (const n of free) h[n] = mean;
    for (let it = 0; it < 20000; it++) {
      let delta = 0;
      for (const n of free) {
        let sw = 0, sh = 0;
        for (const { j, wgt } of adj.get(n) ?? []) { sw += wgt; sh += wgt * h[j]!; }
        if (!sw) continue;
        const v = h[n]! + 1.9 * (sh / sw - h[n]!); // over-relaxed Gauss-Seidel
        delta = Math.max(delta, Math.abs(v - h[n]!));
        h[n] = v;
      }
      if (delta < 1e-5) break;
    }
    // Dijkstra from the free ends
    for (const n of fixed) toEnd[n] = 0;
    const open = new Set(g.nodes);
    while (open.size) {
      let u = -1;
      for (const n of open) if (u < 0 || toEnd[n]! < toEnd[u]!) u = n;
      open.delete(u);
      if (!Number.isFinite(toEnd[u]!)) break;
      for (const { j, wgt } of adj.get(u) ?? []) toEnd[j] = Math.min(toEnd[j]!, toEnd[u]! + 1 / wgt);
    }
    kept.push(g);
  }

  // structures: groups close to each other
  const sp = kept.map((_, i) => i);
  const sfind = (i: number): number => (sp[i] === i ? i : (sp[i] = sfind(sp[i]!)));
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      if (sfind(i) === sfind(j)) continue;
      const near = kept[i]!.nodes.some((a) => kept[j]!.nodes.some((b) => Math.hypot(pos[a]!.x - pos[b]!.x, pos[a]!.z - pos[b]!.z) < CLUSTER));
      if (near) sp[sfind(j)] = sfind(i);
    }
  }
  const structures: Structure[] = [];
  const segs: BridgePlan['segs'] = [];
  const roads = new Set<Road>(), tracks = new Set<Pt[]>(), rails: Pt[][] = [];
  const roots = [...new Set(kept.map((_, i) => sfind(i)))];
  for (const root of roots) {
    const members = kept.filter((_, i) => sfind(i) === root);
    const elIds = members.flatMap((g) => g.els);
    const axisEl = elIds.reduce((best, e) => (cumulative(els[e]!.pts).at(-1)! > cumulative(els[best]!.pts).at(-1)! ? e : best));
    const axis = els[axisEl]!.pts;
    const cum = cumulative(axis);
    const nodes = members.flatMap((g) => g.nodes);
    const proj = new Map(nodes.map((n) => [n, project(axis, cum, pos[n]!).s]));
    const ss = [...proj.values()];
    let w0 = Infinity, w1 = -Infinity, lsum = 0, ln = 0;
    for (const n of nodes) {
      const lvl = isWater(t, w, pos[n]!);
      if (lvl === undefined) continue;
      w0 = Math.min(w0, proj.get(n)!);
      w1 = Math.max(w1, proj.get(n)!);
      lsum += lvl;
      ln++;
    }
    // one profile across the width: every way follows the axis way's heights, blending to its own (its free ends)
    // over the last BLEND metres
    const axisNodes = [...new Set(els[axisEl]!.pts.map((p) => ids.get(ptKey(p))!))];
    const prof = axisNodes.map((n) => ({ s: proj.get(n)!, h: h[n]! })).sort((x, y) => x.s - y.s);
    const axisH = (sv: number) => {
      let i = 1;
      while (i < prof.length - 1 && prof[i]!.s < sv) i++;
      const a = prof[i - 1]!, b = prof[i]!;
      return a.h + ((b.h - a.h) * Math.min(1, Math.max(0, (sv - a.s) / (b.s - a.s || 1))));
    };
    const axisSet = new Set(axisNodes);
    for (const n of nodes) {
      const sv = proj.get(n)!;
      if (axisSet.has(n) || sv < prof[0]!.s || sv > prof.at(-1)!.s) continue;
      const wgt = Math.min(1, toEnd[n]! / BLEND);
      h[n] = h[n]! * (1 - wgt) + axisH(sv) * wgt;
    }
    // arch: just enough to clear the water everywhere
    const a = w0 - ARCH_MARGIN, b = w1 + ARCH_MARGIN;
    const bump = (s: number) => (s > a && s < b ? Math.sin((Math.PI * (s - a)) / (b - a)) : 0);
    let A = 0;
    const clearance = w1 - w0 < SHORT_SPAN ? SHORT_CLEARANCE : CLEARANCE;
    const quarter = (w1 - w0) / 4;
    for (const n of nodes) {
      const lvl = isWater(t, w, pos[n]!);
      const sn = proj.get(n)!;
      if (lvl === undefined || Math.abs(sn - (w0 + w1) / 2) > quarter) continue;
      A = Math.max(A, (lvl + clearance - h[n]!) / bump(sn));
    }
    for (const n of nodes) h[n] = h[n]! + A * bump(proj.get(n)!);
    const st = structures.length;
    structures.push({ axis, cum, s0: Math.min(...ss), s1: Math.max(...ss), w0, w1, meanLevel: lsum / ln, left: [], right: [], top: [] });
    for (const g of members) for (const s of g.segs) segs.push({ ...s, st });
    for (const e of elIds) {
      const el = els[e]!;
      if (el.road) roads.add(el.road);
      if (el.track) tracks.add(el.track);
      if (el.rail) rails.push(el.rail);
    }
  }
  const grid = new Map<string, number[]>();
  segs.forEach((sg, k) => {
    const a = pos[sg.a]!, b = pos[sg.b]!;
    for (let cx = Math.floor((Math.min(a.x, b.x) - GRID_REACH) / GRID); cx <= Math.floor((Math.max(a.x, b.x) + GRID_REACH) / GRID); cx++) {
      for (let cz = Math.floor((Math.min(a.z, b.z) - GRID_REACH) / GRID); cz <= Math.floor((Math.max(a.z, b.z) + GRID_REACH) / GRID); cz++) {
        const key = cellKey(cx, cz);
        grid.set(key, [...(grid.get(key) ?? []), k]);
      }
    }
  });
  return { roads, tracks, rails, structures, pos, h, segs, grid };
}

/** Concatenates meshes (mark kept only if every part has it). */
export function concatMeshes(parts: Mesh[]): Mesh {
  const nv = parts.reduce((n, m) => n + m.positions.length / 3, 0);
  const ni = parts.reduce((n, m) => n + m.indices.length, 0);
  const positions = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), indices = new Uint32Array(ni);
  const marked = parts.length > 0 && parts.every((m) => m.mark);
  const mark = marked ? new Float32Array(nv) : undefined;
  let v = 0, i = 0;
  for (const m of parts) {
    positions.set(m.positions, v * 3);
    uv.set(m.uv, v * 2);
    if (mark) mark.set(m.mark!, v);
    for (let k = 0; k < m.indices.length; k++) indices[i + k] = m.indices[k]! + v;
    v += m.positions.length / 3;
    i += m.indices.length;
  }
  const out: Mesh = { positions, indices, uv };
  if (mark) out.mark = mark;
  return out;
}

/** World-space triangle soup (9 floats per triangle) of a mesh. */
export function triangleSoup(m: Mesh): Float32Array {
  const out = new Float32Array(m.indices.length * 3);
  for (let k = 0; k < m.indices.length; k++) out.set(m.positions.subarray(m.indices[k]! * 3, m.indices[k]! * 3 + 3), k * 3);
  return out;
}

/** Deck height under (x, z) from the nearest deck way, with its structure and distance; undefined without decks. */
export function deckAt(plan: BridgePlan, x: number, z: number): { y: number; st: number; d: number } | undefined {
  let best: { y: number; st: number; d: number } | undefined;
  const near = plan.grid.get(cellKey(Math.floor(x / GRID), Math.floor(z / GRID)));
  if (!near) return undefined;
  for (const k of near) {
    const s = plan.segs[k]!;
    const a = plan.pos[s.a]!, b = plan.pos[s.b]!;
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1;
    const u = Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / l2));
    const d = Math.hypot(x - a.x - ex * u, z - a.z - ez * u);
    if (!best || d < best.d) best = { y: plan.h[s.a]! + (plan.h[s.b]! - plan.h[s.a]!) * u, st: s.st, d };
  }
  return best;
}

/** Lifts a deck mesh (y = offset above the deck) onto the deck heights; returns a new mesh. */
export function liftOntoDecks(m: Mesh, plan: BridgePlan): Mesh {
  const positions = Float32Array.from(m.positions);
  for (let v = 0; v < positions.length; v += 3) positions[v + 1] = positions[v + 1]! + (deckAt(plan, positions[v]!, positions[v + 2]!)?.y ?? 0);
  const out: Mesh = { positions, indices: m.indices, uv: m.uv };
  if (m.mark) out.mark = m.mark;
  return out;
}

type V3 = [number, number, number];

class Builder {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** Quad a, b, c, d (a convex loop), wound so that its normal points along `out`; uv = given per corner. */
  quad(a: V3, b: V3, c: V3, d: V3, out: V3, uv: [number, number][]): void {
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const flip = n[0]! * out[0] + n[1]! * out[1] + n[2]! * out[2] < 0;
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.pos.push(...p);
    for (const t of uv) this.uv.push(...t);
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Box between two cross-sections (4 corners each: bottom-left, bottom-right, top-right, top-left), all faces outward. */
  box(p: V3[], q: V3[], u0: number, u1: number): void {
    const centre: V3 = [0, 1, 2].map((k) => [...p, ...q].reduce((s, v) => s + v[k]!, 0) / 8) as V3;
    const face = (f: V3[]) => {
      const m = [0, 1, 2].map((k) => f.reduce((s, v) => s + v[k]!, 0) / 4);
      const out: V3 = [m[0]! - centre[0], m[1]! - centre[1], m[2]! - centre[2]];
      const w = Math.hypot(f[1]![0] - f[0]![0], f[1]![2] - f[0]![2]) || Math.hypot(f[3]![0] - f[0]![0], f[3]![2] - f[0]![2]);
      this.quad(f[0]!, f[1]!, f[2]!, f[3]!, out, [[0, f[0]![1]], [w, f[1]![1]], [w, f[2]![1]], [0, f[3]![1]]]);
    };
    const [p0, p1, p2, p3] = p as [V3, V3, V3, V3];
    const [q0, q1, q2, q3] = q as [V3, V3, V3, V3];
    face([p0, p1, p2, p3]); // start cap
    face([q0, q1, q2, q3]); // end cap
    this.quad(p0, q0, q3, p3, sideOut(p0, p1), [[u0, p0[1]], [u1, q0[1]], [u1, q3[1]], [u0, p3[1]]]); // left
    this.quad(p1, q1, q2, p2, sideOut(p1, p0), [[u0, p1[1]], [u1, q1[1]], [u1, q2[1]], [u0, p2[1]]]); // right
    this.quad(p3, q3, q2, p2, [0, 1, 0], [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]); // top
    this.quad(p0, q0, q1, p1, [0, -1, 0], [[u0, 0], [u1, 0], [u1, 1], [u0, 1]]); // bottom
  }
  build(): Mesh {
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx), uv: Float32Array.from(this.uv) };
  }
}
const sideOut = (from: V3, other: V3): V3 => [from[0] - other[0], 0, from[2] - other[2]];

/**
 * Structure profiles from the lifted deck meshes, then the bridge bodies: per structure a slab under all its decks
 * (top SLAB_GAP below the lowest deck surface of each bin, so it also closes the gaps between separate decks),
 * parapets along both edges where the deck is clear of the ground, and piers in the water. Returns the body mesh
 * (uv: metres along / up) and its collision triangles (slab, parapets, piers).
 */
export function bridgeBodies(plan: BridgePlan, decks: Mesh[], t: TerrainGrid): { mesh: Mesh; collision: Float32Array } {
  const bins = plan.structures.map((s) => {
    const n = Math.max(2, Math.ceil((s.s1 - s.s0) / BIN) + 1);
    return { lo: new Array<number>(n).fill(Infinity), hi: new Array<number>(n).fill(-Infinity), y: new Array<number>(n).fill(Infinity) };
  });
  for (const m of decks) {
    const P = m.positions;
    for (let v = 0; v < P.length; v += 3) {
      const at = deckAt(plan, P[v]!, P[v + 2]!);
      if (!at) continue;
      const s = plan.structures[at.st]!;
      const pr = project(s.axis, s.cum, { x: P[v]!, z: P[v + 2]! });
      const b = bins[at.st]!;
      const i = Math.round((pr.s - s.s0) / BIN);
      if (i < 0 || i >= b.lo.length) continue;
      b.lo[i] = Math.min(b.lo[i]!, pr.lat);
      b.hi[i] = Math.max(b.hi[i]!, pr.lat);
      b.y[i] = Math.min(b.y[i]!, P[v + 1]!);
    }
  }
  const body = new Builder();
  const coll: number[] = [];
  const addColl = (m: Mesh, from: number) => {
    for (let k = from; k < m.indices.length; k++) coll.push(m.positions[m.indices[k]! * 3]!, m.positions[m.indices[k]! * 3 + 1]!, m.positions[m.indices[k]! * 3 + 2]!);
  };
  plan.structures.forEach((s, st) => {
    const b = bins[st]!;
    const n = b.lo.length;
    // fill bins without deck vertices from their neighbours, then widen/lower over ±2 bins
    const fill = (a: number[]) => {
      const known = a.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
      if (!known.length) return false;
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(a[i]!)) continue;
        const prev = known.filter((k) => k < i).at(-1), next = known.find((k) => k > i);
        a[i] = prev === undefined ? a[next!]! : next === undefined ? a[prev]! : a[prev]! + ((a[next]! - a[prev]!) * (i - prev)) / (next - prev);
      }
      return true;
    };
    if (!fill(b.lo) || !fill(b.hi) || !fill(b.y)) return;
    const win = (a: number[], i: number, f: (...v: number[]) => number) => f(...a.slice(Math.max(0, i - 2), Math.min(n, i + 3)));
    s.left = b.lo.map((_, i) => win(b.lo, i, Math.min));
    s.right = b.hi.map((_, i) => win(b.hi, i, Math.max));
    s.top = b.y.map((_, i) => win(b.y, i, Math.min) - SLAB_GAP);
    const at = (i: number, lat: number, y: number): V3 => {
      const { p, dir } = pointAt(s.axis, s.cum, s.s0 + i * BIN);
      return [p.x - dir.z * lat, y, p.z + dir.x * lat];
    };
    const section = (i: number, l: number, r: number, y0: number, y1: number): V3[] => [at(i, l, y0), at(i, r, y0), at(i, r, y1), at(i, l, y1)];
    const from = body.idx.length;
    for (let i = 1; i < n; i++) {
      const u0 = (i - 1) * BIN, u1 = i * BIN;
      body.box(section(i - 1, s.left[i - 1]!, s.right[i - 1]!, s.top[i - 1]! - SLAB_DEPTH, s.top[i - 1]!), section(i, s.left[i]!, s.right[i]!, s.top[i]! - SLAB_DEPTH, s.top[i]!), u0, u1);
      // parapets: on the slab, outside the outermost deck edge
      for (const side of [-1, 1]) {
        const edge = (k: number) => (side < 0 ? s.left[k]! : s.right[k]!);
        const clear = [i - 1, i].every((k) => {
          const e = at(k, edge(k), 0);
          return s.top[k]! - heightAt(t, e[0], e[2]) > PARAPET_MIN_RISE;
        });
        if (!clear) continue;
        const sec = (k: number) => {
          const inner = edge(k), outer = edge(k) + side * PARAPET_W;
          const [l, r] = side < 0 ? [outer, inner] : [inner, outer];
          return section(k, l, r, s.top[k]!, s.top[k]! + SLAB_GAP + PARAPET_H);
        };
        body.box(sec(i - 1), sec(i), u0, u1);
      }
    }
    // piers: evenly spaced over the water span
    if (Number.isFinite(s.w0) && s.w1 - s.w0 > 60) {
      const count = Math.max(1, Math.round((s.w1 - s.w0) / PIER_SPACING) - 1);
      const bed = s.meanLevel - WATER_DEPTH - 1;
      for (let k = 1; k <= count; k++) {
        const sm = s.w0 + ((s.w1 - s.w0) * k) / (count + 1);
        const i = Math.round((sm - s.s0) / BIN);
        if (i < 0 || i >= n) continue;
        const l = s.left[i]! + PIER_INSET, r = s.right[i]! - PIER_INSET;
        if (r - l < 2) continue;
        const top = s.top[i]! - SLAB_DEPTH;
        const half = PIER_LEN / 2 / BIN;
        body.box(section(i - half, l, r, bed, top), section(i + half, l, r, bed, top), 0, PIER_LEN);
      }
    }
    addColl(body.build(), from);
  });
  return { mesh: body.build(), collision: Float32Array.from(coll) };
}

/** True if p lies on a bridge structure (within its profile, at least 1 m above the ground), e.g. to keep props off. */
export function onBridge(plan: BridgePlan, t: TerrainGrid, p: Pt): boolean {
  const at = deckAt(plan, p.x, p.z);
  if (!at || at.d > 40) return false;
  const s = plan.structures[at.st]!;
  if (!s.top.length) return false;
  const pr = project(s.axis, s.cum, p);
  const i = Math.round((pr.s - s.s0) / BIN);
  if (i < 0 || i >= s.top.length) return false;
  return pr.lat >= s.left[i]! - 1 && pr.lat <= s.right[i]! + 1 && s.top[i]! - heightAt(t, p.x, p.z) > 1;
}
