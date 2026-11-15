import type { Pt, Road } from './osm.js';
import { cumulative, dedupe, dist, DRIVABLE, junctions, offsetLine, pointAt, ptKey, subPolyline } from './polyline.js';
import type { Mesh } from './streets.js';
import { edgeAt, edges, sideOffsets } from './roadprofile.js';

/** Markings lie this far above their road ribbon. */
export const MARK_DY = 0.004;
const LINE_W = 0.12;
const WIDE_W = 0.25; // Breitstrich: cycle lane boundary
const DASH: [number, number] = [3, 6]; // Leitlinie / lane divider: dash, gap
const FURT: [number, number] = [1, 1]; // cycle lane boundary across a junction
const BIKE_EVERY = 40;
const BIKE_FIRST = 20;
const NODE_CLEAR = 5; // no white marking closer to a junction node
const RED_MAX = 12; // red cycle crossing at most this far from its node
const CONFLICT_MARGIN = 0.2; // white lines stop this far outside a crossing carriageway
const FURT_MARGIN = 1.0; // the cycle crossing reaches this far beyond the crossing carriageway's edge
const ARM_LEN = 60;
const STEP = 0.25;
const MIN_PIECE = 0.3;
/** Kinds with a centre line (Leitlinie); Tempo-30 residential streets have none. */
const CENTRE_KINDS = new Set(['primary', 'secondary', 'tertiary', 'unclassified']);
const COS15 = Math.cos((15 * Math.PI) / 180);
const COS30 = Math.cos((30 * Math.PI) / 180);

export type PieceKind = 'centre' | 'lane' | 'cycle' | 'park' | 'furt' | 'red' | 'bike';
/**
 * One emitted marking (for tests and stats): arc lengths on its road, side (+1 right, -1 left, 0 centre), centre
 * position; bike pictograms also carry the direction they face (+1 along the way, -1 against it).
 */
export type Piece = { kind: PieceKind; road: number; side: number; s0: number; s1: number; x: number; z: number; travel?: number };

/** kl/kr: kerb distance left/right of the arm's direction (away from the node). */
type Arm = { dir: Pt; kl: number; kr: number; road: Road; y: number };
/** An offset from the centre line, constant or per arc length. */
type Off = number | ((s: number) => number);
const val = (o: Off, s: number): number => (typeof o === 'number' ? o : o(s));
/** One arm of a road at a junction node: the other carriageways it crosses there, and whether the road goes straight on. */
type NodeArm = { conflicts: Arm[]; through: boolean };
type RoadNode = { p: Pt; s: number; back?: NodeArm; ahead?: NodeArm };

const unit = (a: Pt, b: Pt): Pt => {
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
};
const dot = (a: Pt, b: Pt) => a.x * b.x + a.z * b.z;

class MarkBuilder {
  pos: number[] = []; uv: number[] = []; mark: number[] = []; idx: number[] = [];

  /** Strip between two lines (b right of a), u along, v across. */
  strip(a: Pt[], b: Pt[], u: number[], w: number, y: number, m: number): void {
    for (let i = 0; i < a.length; i++) {
      const base = this.pos.length / 3;
      this.pos.push(a[i]!.x, y, a[i]!.z, b[i]!.x, y, b[i]!.z);
      this.uv.push(u[i]!, 0, u[i]!, w);
      this.mark.push(m, m);
      if (i > 0) this.idx.push(base - 2, base - 1, base, base, base - 1, base + 1);
    }
  }

  /** Convex quad (any winding), turned to face up. */
  quad(q: Pt[], uv: Pt[], y: number, m: number): void {
    const base = this.pos.length / 3;
    q.forEach((p, i) => {
      this.pos.push(p.x, y, p.z);
      this.uv.push(uv[i]!.x, uv[i]!.z);
      this.mark.push(m);
    });
    for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]] as const) {
      const cr = (q[b]!.z - q[a]!.z) * (q[c]!.x - q[a]!.x) - (q[b]!.x - q[a]!.x) * (q[c]!.z - q[a]!.z);
      this.idx.push(base + a, base + (cr >= 0 ? b : c), base + (cr >= 0 ? c : b));
    }
  }

  build(): Mesh {
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx), uv: Float32Array.from(this.uv), mark: Float32Array.from(this.mark) };
  }
}

/** Intervals of [a, b] covered by a dash pattern [on, off] anchored at arc length 0. */
function dashes(a: number, b: number, [on, off]: [number, number]): [number, number][] {
  const p = on + off;
  const out: [number, number][] = [];
  for (let k = Math.floor(a / p); k * p < b; k++) {
    const s0 = Math.max(a, k * p), s1 = Math.min(b, k * p + on);
    if (s1 > s0) out.push([s0, s1]);
  }
  return out;
}

/** Bike pictogram in local units (x across to the right of travel, y along travel): wheel rings and frame bars. */
const BIKE_WHEELS: Pt[] = [{ x: -0.32, z: -0.12 }, { x: 0.32, z: -0.12 }];
const WHEEL_R = 0.17;
const BAR = 0.045;
const BIKE_BARS: [number, number, number, number][] = [
  [-0.32, -0.12, -0.02, -0.12], [-0.02, -0.12, -0.12, 0.14], [-0.12, 0.14, 0.2, 0.14], [0.2, 0.14, -0.02, -0.12],
  [-0.32, -0.12, -0.12, 0.14], [0.2, 0.14, 0.32, -0.12], [-0.2, 0.19, -0.04, 0.19], [-0.12, 0.14, -0.12, 0.19],
  [0.2, 0.14, 0.17, 0.24], [0.13, 0.24, 0.27, 0.24],
];
const BIKE_HALF_X = 0.32 + WHEEL_R; // local half extent across
const BIKE_SY = 2.0; // stretched along travel, as painted
const BIKE_HALF_Y = 0.3 * BIKE_SY; // world half extent along (approx.)

/**
 * Lane markings of all drivable roads: dashed centre line (3 m / 6 m) on two-way roads of CENTRE_KINDS (a solid
 * double line, 2 × 0.12 m with 0.12 m between, with ≥ 2 lanes per direction), dashed lane
 * dividers with ≥ 2 lanes per direction, cycle lane boundaries (0.25 m Breitstrich towards the traffic lane, 0.12 m
 * line towards a parking strip), broken 1 m / 1 m and filled red (`mark` 1) where a through road's cycle lane crosses
 * a side street (≤ 12 m from the node), bike pictograms every 40 m facing the lane's travel direction. White markings keep 5 m from junction nodes and
 * stop before crossing carriageways. Ribbons y = roadY(road) + 0.004; road rank is compared via roadY.
 */
export function buildMarkings(roads: Road[], roadY: (r: Road) => number): { mesh: Mesh; pieces: Piece[] } {
  const out = new MarkBuilder();
  const pieces: Piece[] = [];
  const drivable = roads.map((r) => ({ r, pts: dedupe(r.points) })).filter((q) => DRIVABLE.has(q.r.kind) && q.pts.length >= 2);
  const junc = junctions(drivable.map((q) => q.pts));
  const arms = new Map<string, Arm[]>();
  for (const { r, pts } of drivable) {
    pts.forEach((p, i) => {
      const key = ptKey(p);
      if (!junc.has(key)) return;
      const list = arms.get(key) ?? [];
      const kl = edges(r, -1, 'kerb')[i]!, kr = edges(r, 1, 'kerb')[i]!;
      const a = { road: r, y: roadY(r) };
      if (i > 0) list.push({ ...a, dir: unit(p, pts[i - 1]!), kl: kr, kr: kl }); // against the way: sides swap
      if (i < pts.length - 1) list.push({ ...a, dir: unit(p, pts[i + 1]!), kl, kr });
      arms.set(key, list);
    });
  }
  const nodeCells = new Map<string, Pt[]>();
  const cell = (x: number, z: number) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
  for (const p of junc.values()) {
    const k = cell(p.x, p.z);
    nodeCells.set(k, [...(nodeCells.get(k) ?? []), p]);
  }
  /** Within NODE_CLEAR of any junction node. */
  const nearNode = (q: Pt): boolean => {
    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        for (const n of nodeCells.get(cell(q.x + i * 10, q.z + k * 10)) ?? []) if (dist(q, n) < NODE_CLEAR) return true;
      }
    }
    return false;
  };

  for (const { r, pts } of drivable) {
    const cum = cumulative(pts);
    const len = cum[cum.length - 1]!;
    const y = roadY(r) + MARK_DY;
    const nodeArm = (p: Pt, u: Pt): NodeArm => {
      const all = arms.get(ptKey(p)) ?? [];
      return {
        conflicts: all.filter((a) => !(a.road === r && dot(a.dir, u) > 0.999) && dot(a.dir, u) <= COS15 && dot(a.dir, u) >= -COS30),
        through: all.some((a) => dot(a.dir, u) < -COS30),
      };
    };
    const nodes: RoadNode[] = [];
    pts.forEach((p, i) => {
      if (!junc.has(ptKey(p))) return;
      nodes.push({
        p, s: cum[i]!,
        back: i > 0 ? nodeArm(p, unit(p, pts[i - 1]!)) : undefined,
        ahead: i < pts.length - 1 ? nodeArm(p, unit(p, pts[i + 1]!)) : undefined,
      });
    });
    const at = (s: number, d: number): Pt => {
      const { p, dir } = pointAt(pts, cum, s);
      return { x: p.x - dir.z * d, z: p.z + dir.x * d };
    };
    /** The node and crossing arm whose carriageway (+ margin) contains q, the point at arc length s; null if none. */
    const conflict = (s: number, q: Pt, margin: number): { node: RoadNode; arm: Arm; through: boolean } | null => {
      for (const n of nodes) {
        if (Math.abs(s - n.s) > ARM_LEN) continue;
        const na = s >= n.s ? (n.ahead ?? n.back)! : (n.back ?? n.ahead)!;
        for (const a of na.conflicts) {
          // beside the arm's centre line, on its side of the node (no round cap reaching across the through road)
          const along = (q.x - n.p.x) * a.dir.x + (q.z - n.p.z) * a.dir.z;
          const across = (q.x - n.p.x) * -a.dir.z + (q.z - n.p.z) * a.dir.x; // > 0: right of the arm
          if (along > -0.5 && along < ARM_LEN && Math.abs(across) < (across >= 0 ? a.kr : a.kl) + margin) return { node: n, arm: a, through: na.through };
        }
      }
      return null;
    };
    /** Node of the cycle crossing at arc length s for a cycle lane centred at d: through road, not outranked. */
    const furtNode = (s: number, d: number): RoadNode | null => {
      const c = conflict(s, at(s, d), FURT_MARGIN);
      return c && c.through && roadY(r) >= c.arm.y ? c.node : null;
    };
    const samples: number[] = [];
    for (let s = 0; s < len; s += STEP) samples.push(s);
    samples.push(len);

    const emit = (kind: PieceKind, side: number, a: number, b: number, d0: Off, d1: Off, m: number) => {
      if (b - a < MIN_PIECE) return;
      const seg = subPolyline(pts, cum, a, b);
      if (seg.length < 2) return;
      const u = cumulative(seg).map((v) => v + a);
      const sm = (a + b) / 2;
      out.strip(offsetLine(seg, u.map((v) => val(d0, v))), offsetLine(seg, u.map((v) => val(d1, v))), u, val(d1, sm) - val(d0, sm), y, m);
      const mid = at(sm, (val(d0, sm) + val(d1, sm)) / 2);
      pieces.push({ kind, road: r.id, side, s0: a, s1: b, x: mid.x, z: mid.z });
    };
    /** Runs of consecutive samples with the same non-null state. */
    const runs = <T>(state: (s: number) => T | null): { st: T; a: number; b: number }[] => {
      const res: { st: T; a: number; b: number }[] = [];
      let cur: { st: T; a: number; b: number } | null = null;
      for (const s of samples) {
        const st = state(s);
        if (cur && st === cur.st) cur.b = s;
        else {
          if (cur) res.push(cur);
          cur = st === null ? null : { st, a: s, b: s };
        }
      }
      if (cur) res.push(cur);
      return res;
    };
    /** A white line centred at d, width w; `cycleAt` (cycle lane centre) makes it a cycle line broken 1/1 across crossings. */
    const line = (kind: PieceKind, side: number, d: Off, w: number, pattern: [number, number] | null, cycleAt?: Off, when?: (s: number) => boolean) => {
      const state = (s: number): 'n' | 'f' | null => {
        if (when && !when(s)) return null;
        const q0 = at(s, val(d, s) - w / 2), q1 = at(s, val(d, s) + w / 2);
        if (nearNode(q0) || nearNode(q1)) return null;
        if (cycleAt !== undefined && furtNode(s, val(cycleAt, s))) return 'f';
        return conflict(s, q0, CONFLICT_MARGIN) || conflict(s, q1, CONFLICT_MARGIN) ? null : 'n';
      };
      for (const { st, a, b } of runs(state)) {
        const pat = st === 'f' ? FURT : pattern;
        for (const [s0, s1] of pat ? dashes(a, b, pat) : [[a, b] as [number, number]]) emit(st === 'f' ? 'furt' : kind, side, s0, s1, (s) => val(d, s) - w / 2, (s) => val(d, s) + w / 2, 0);
      }
    };

    const c = r.cross;
    const lw = c.laneWidth;
    // lanes lie symmetric about the way's centre line (roadprofile.ts); lane markings stay straight
    const centre = -sideOffsets(c).left.lane + c.lanesBackward * lw;
    if (c.lanesForward > 0 && c.lanesBackward > 0 && CENTRE_KINDS.has(r.kind)) {
      // ≥ 2 lanes per direction: solid double line (Doppellinie), otherwise a dashed Leitlinie
      if (c.lanesForward >= 2 && c.lanesBackward >= 2) for (const k of [-1, 1]) line('centre', 0, centre + k * LINE_W, LINE_W, null);
      else line('centre', 0, centre, LINE_W, DASH);
    }
    for (let k = 1; k < c.lanesForward; k++) line('lane', 1, centre + k * lw, LINE_W, DASH);
    for (let k = 1; k < c.lanesBackward; k++) line('lane', -1, centre - k * lw, LINE_W, DASH);

    for (const side of [1, -1]) {
      const cyc = side > 0 ? c.cycleRight : c.cycleLeft;
      const park = side > 0 ? c.parkRight : c.parkLeft;
      if (cyc <= 0) continue;
      // edges follow the profile (ramps between ways); a strip counts where it is ≥ 0.5 m wide
      const inner = (s: number) => side * edgeAt(r, side, 'lane', s); // edge towards the traffic lane
      const outer = (s: number) => side * edgeAt(r, side, 'cycle', s); // edge towards the kerb or parking strip
      const hasPark = (s: number) => edgeAt(r, side, 'kerb', s) - edgeAt(r, side, 'cycle', s) >= 0.5;
      const lineIn = (s: number) => inner(s) + side * WIDE_W; // free cycle lane between the two lines
      const lineOut = (s: number) => (hasPark(s) ? outer(s) - side * LINE_W : outer(s));
      const mid = (s: number) => (lineIn(s) + lineOut(s)) / 2;
      line('cycle', side, (s) => inner(s) + (side * WIDE_W) / 2, WIDE_W, null, mid);
      if (park > 0) line('park', side, (s) => outer(s) - (side * LINE_W) / 2, LINE_W, null, mid, hasPark);
      // red crossing: the free cycle lane between the lines, where every corner is ≤ RED_MAX from the node
      const [d0, d1] = side > 0 ? [lineIn, lineOut] : [lineOut, lineIn];
      const red = (s: number): RoadNode | null => {
        const n = furtNode(s, mid(s));
        return n && dist(at(s, d0(s)), n.p) <= RED_MAX && dist(at(s, d1(s)), n.p) <= RED_MAX ? n : null;
      };
      for (const { a, b } of runs(red)) emit('red', side, a, b, d0, d1, 1);
      // pictograms facing the direction of travel of this lane
      for (let s = BIKE_FIRST; s < len - BIKE_HALF_Y; s += BIKE_EVERY) {
        const half = Math.abs(lineOut(s) - lineIn(s)) / 2;
        const sx = Math.min(1.1, (0.85 * half) / BIKE_HALF_X);
        const clear = [s - BIKE_HALF_Y, s + BIKE_HALF_Y].every((sa) =>
          [mid(sa) - half, mid(sa) + half].every((dd) => {
            const q = at(sa, dd);
            return !nearNode(q) && !conflict(sa, q, CONFLICT_MARGIN);
          }) && !furtNode(sa, mid(sa)));
        if (!clear) continue;
        const { p, dir } = pointAt(pts, cum, s);
        const travel = side > 0 ? c.cycleRightDir : c.cycleLeftDir;
        const f = { x: dir.x * travel, z: dir.z * travel };
        const rt = { x: -f.z, z: f.x };
        const o = at(s, mid(s));
        const w = (x: number, yy: number): Pt => ({ x: o.x + rt.x * x * sx + f.x * yy * BIKE_SY, z: o.z + rt.z * x * sx + f.z * yy * BIKE_SY });
        const bar = (x0: number, y0: number, x1: number, y1: number) => {
          const l = Math.hypot(x1 - x0, y1 - y0) || 1;
          const nx = (-(y1 - y0) / l) * (BAR / 2), ny = ((x1 - x0) / l) * (BAR / 2);
          const ex = ((x1 - x0) / l) * (BAR / 2), ey = ((y1 - y0) / l) * (BAR / 2);
          const loc = [{ x: x0 - ex + nx, z: y0 - ey + ny }, { x: x1 + ex + nx, z: y1 + ey + ny }, { x: x1 + ex - nx, z: y1 + ey - ny }, { x: x0 - ex - nx, z: y0 - ey - ny }];
          out.quad(loc.map((q) => w(q.x, q.z)), loc, y, 0);
        };
        for (const wh of BIKE_WHEELS) {
          const n = 14;
          for (let i = 0; i < n; i++) {
            const t0 = (i / n) * 2 * Math.PI, t1 = ((i + 1) / n) * 2 * Math.PI;
            const ring = (t: number, rr: number) => ({ x: wh.x + Math.cos(t) * rr, z: wh.z + Math.sin(t) * rr });
            const loc = [ring(t0, WHEEL_R), ring(t1, WHEEL_R), ring(t1, WHEEL_R - BAR), ring(t0, WHEEL_R - BAR)];
            out.quad(loc.map((q) => w(q.x, q.z)), loc, y, 0);
          }
        }
        for (const b of BIKE_BARS) bar(...b);
        pieces.push({ kind: 'bike', road: r.id, side, s0: s, s1: s, x: p.x, z: p.z, travel });
      }
    }
  }
  return { mesh: out.build(), pieces };
}
