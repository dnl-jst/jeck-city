import { heightAt, STATION, TRAIN_LENGTH, transitModel, type TerrainGrid, type Transit } from '@nn/shared';
import type { Rect } from './chunks.js';
import type { OsmFeatures, Pt } from './osm.js';
import { pointInPolygon } from './polyline.js';
import {
  buildStair, CEIL, ColorMesh, COLORS, DEPTH, EDGE, encodeModels, FLOOR, GAUGE, hash, PAVEMENT_H, PLATFORM_H, RAIL_W, STAIR_SLOPE, STAIR_W, STATION_LOOK,
  TILE_TONES, TILE_W, type RGB, type Stair, type TransitBuild, type V3,
} from './transit.js';
import type { CityEnv } from './transitenv.js';
import type { RailWay, Route } from './transitnet.js';

/**
 * The whole Stadtbahn network, built from the OSM track ways the lines run on (transitnet.ts).
 *
 * Heights: every track point gets a height on the network as a whole (ways share their end points): on the ground the
 * terrain, in a tunnel DEPTH below the lowest ground around, coming up to the ground over RAMP towards a portal, on a
 * bridge a straight line between its ends; then smoothed along the tracks.
 *
 * Tunnels: each tunnel track is swept on its own: a floor and a ceiling to both sides, as far as its neighbour allows
 * (half way to a parallel track, to the edge of a platform, else WALL_CLEAR and a wall). So two tracks side by side
 * share one box, and where they part each gets its own.
 *
 * Stations: where an OSM platform lies beside a tunnel track, a platform slab of that width, the hall's ceiling over it
 * and its back wall; between two tracks an island platform (built by the track with the lower way id). Stairs go up
 * to the street from each platform, as in the prototype.
 *
 * Trains: one path per line and direction, through the play area, with its stops.
 */
const STEP = 2;
const WALL_CLEAR = STATION.wallClear;
/** Seconds between two trains of a line and direction (the real timetable replaces this). */
const HEADWAY = 600;
/** A tunnel comes up to the ground over this distance from its portal (m, along the track). */
const RAMP = 130;
/** Tunnels of OSM layer −3 and lower pass under others: this much deeper (m). */
const DEEP_EXTRA = 5.5;
/** Platforms: found up to this far beside a track; at least this wide; a run shorter than this many samples is none. */
const PLATFORM_REACH = 9, PLATFORM_MIN_RUN = 10;
/** A side platform is at least this wide, whatever OSM draws (m): room for a stair beside the way along it. */
const SIDE_PLATFORM_W = STATION.platformWidth;

type Way = {
  id: number; kind: RailWay['kind']; layer: number;
  x: Float64Array; z: Float64Array; y: Float64Array; n: number;
  /** Global node per point (ways share nodes at their ends), −1 outside the world. */
  node: Int32Array;
  /** Unit forward (in point order) per point. */
  fx: Float64Array; fz: Float64Array;
  /** Per side (0 left, 1 right) and point: how far the tunnel's floor reaches, whether a wall stands there. */
  ext: [Float64Array, Float64Array]; wall: [Uint8Array, Uint8Array];
  /**
   * Per side and point: a platform's far edge from the track (0: none) and its kind: 1 a side platform (back wall),
   * 2 an island this way builds, 3 an island the other track builds.
   */
  far: [Float64Array, Float64Array]; plat: [Uint8Array, Uint8Array];
  /** Platform name per side and point (index into `names`, −1). */
  name: [Int32Array, Int32Array];
  light: Float64Array;
};

export async function buildNetwork(
  routes: Route[], rail: Map<number, RailWay>, f: OsmFeatures, env: CityEnv & { terrain: TerrainGrid; area: Rect },
): Promise<TransitBuild | null> {
  if (routes.length === 0) return null;
  const { terrain, area } = env;
  const inWorld = (x: number, z: number) => x > area.minX + 4 && x < area.maxX - 4 && z > area.minZ + 4 && z < area.maxZ - 4;

  // ---- the ways the lines use, resampled (OSM's own vertices are kept: ways meet in them) ----
  const used = new Set(routes.flatMap((r) => r.parts.map((p) => p.way)));
  const ways = new Map<number, Way>();
  const nodeOf = new Map<string, number>();
  const NX: number[] = [], NZ: number[] = [], adj: number[][] = [];
  const nodeKind: RailWay['kind'][] = [], nodeLayer: number[] = [];
  const key = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  for (const id of [...used].sort((a, b) => a - b)) {
    const w = rail.get(id);
    if (!w) continue;
    const xs: number[] = [], zs: number[] = [];
    for (let i = 0; i < w.pts.length; i++) {
      const a = w.pts[i]!;
      if (i > 0) {
        const p = w.pts[i - 1]!, n = Math.max(1, Math.ceil(Math.hypot(a.x - p.x, a.z - p.z) / STEP));
        for (let k = 1; k < n; k++) { xs.push(p.x + ((a.x - p.x) * k) / n); zs.push(p.z + ((a.z - p.z) * k) / n); }
      }
      xs.push(a.x);
      zs.push(a.z);
    }
    const n = xs.length, node = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (!inWorld(xs[i]!, zs[i]!)) continue;
      const k = key(xs[i]!, zs[i]!);
      let j = nodeOf.get(k);
      if (j === undefined) {
        j = NX.length;
        nodeOf.set(k, j);
        NX.push(xs[i]!);
        NZ.push(zs[i]!);
        adj.push([]);
        nodeKind.push(w.kind);
        nodeLayer.push(w.layer);
      } else if (w.kind === 'tunnel' && nodeKind[j] !== 'tunnel') {
        // a portal: the end shared with a way on the ground stays on the ground
      } else if (w.kind !== 'tunnel' && nodeKind[j] === 'tunnel') {
        nodeKind[j] = w.kind;
        nodeLayer[j] = w.layer;
      }
      node[i] = j;
      if (i > 0 && node[i - 1]! >= 0 && node[i - 1] !== j) { adj[j]!.push(node[i - 1]!); adj[node[i - 1]!]!.push(j); }
    }
    const fx = new Float64Array(n), fz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), l = Math.hypot(xs[b]! - xs[a]!, zs[b]! - zs[a]!) || 1;
      fx[i] = (xs[b]! - xs[a]!) / l;
      fz[i] = (zs[b]! - zs[a]!) / l;
    }
    const f64 = () => new Float64Array(n), u8 = () => new Uint8Array(n);
    ways.set(id, {
      id, kind: w.kind, layer: w.layer, x: Float64Array.from(xs), z: Float64Array.from(zs), y: f64(), n, node, fx, fz,
      ext: [f64(), f64()], wall: [u8(), u8()], far: [f64(), f64()], plat: [u8(), u8()], name: [new Int32Array(n).fill(-1), new Int32Array(n).fill(-1)], light: f64(),
    });
  }
  const N = NX.length;
  if (N === 0) return null;
  /** Nodes where a track ends (at the world's edge): they keep to their target height. */
  const trackEnd = adj.map((a) => a.length <= 1);
  // Tunnel tracks side by side (the two directions of a line, the tracks of a station) are tied together: each point
  // to the one beside it on the other track. So their heights come out the same, and a station is level across.
  {
    const cell = 8, grid = new Map<string, [Way, number][]>();
    const tunnels = [...ways.values()].filter((w) => w.kind === 'tunnel');
    for (const w of tunnels) {
      for (let i = 0; i < w.n; i++) {
        if (w.node[i]! < 0) continue;
        const k = `${Math.floor(w.x[i]! / cell)}_${Math.floor(w.z[i]! / cell)}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push([w, i]);
      }
    }
    for (const w of tunnels) {
      for (let i = 0; i < w.n; i++) {
        if (w.node[i]! < 0) continue;
        let best = -1, bd = 16;
        const cx = Math.floor(w.x[i]! / cell), cz = Math.floor(w.z[i]! / cell);
        for (let gx = cx - 2; gx <= cx + 2; gx++) {
          for (let gz = cz - 2; gz <= cz + 2; gz++) {
            for (const [o, j] of grid.get(`${gx}_${gz}`) ?? []) {
              if (o === w || o.layer !== w.layer || Math.abs(o.fx[j]! * w.fx[i]! + o.fz[j]! * w.fz[i]!) < 0.9) continue;
              const dx = o.x[j]! - w.x[i]!, dz = o.z[j]! - w.z[i]!;
              if (Math.abs(dx * w.fx[i]! + dz * w.fz[i]!) > 1.2) continue;
              const d = Math.hypot(dx, dz);
              if (d < bd) { bd = d; best = o.node[j]!; }
            }
          }
        }
        const a = w.node[i]!;
        if (best >= 0 && best !== a && !adj[a]!.includes(best)) { adj[a]!.push(best); adj[best]!.push(a); }
      }
    }
  }

  // ---- heights on the network ----
  // distance along the tracks to the nearest point that is not in a tunnel (a portal)
  const toPortal = new Float64Array(N).fill(Infinity);
  {
    let front: number[] = [];
    for (let i = 0; i < N; i++) if (nodeKind[i] !== 'tunnel') { toPortal[i] = 0; front.push(i); }
    while (front.length) {
      const next: number[] = [];
      for (const i of front) {
        for (const j of adj[i]!) {
          const d = toPortal[i]! + Math.hypot(NX[i]! - NX[j]!, NZ[i]! - NZ[j]!);
          if (d < toPortal[j]! - 1e-6) { toPortal[j] = d; next.push(j); }
        }
      }
      front = next;
    }
  }
  const ground = new Float64Array(N);
  for (let i = 0; i < N; i++) ground[i] = heightAt(terrain, NX[i]!, NZ[i]!);
  // the lowest ground within about 40 m along the tracks (and a tunnel's width to the sides is small against that)
  const low = Float64Array.from(ground);
  for (let pass = 0; pass < 20; pass++) {
    const prev = Float64Array.from(low);
    for (let i = 0; i < N; i++) for (const j of adj[i]!) if (prev[j]! < low[i]!) low[i] = prev[j]!;
  }
  const target = new Float64Array(N), pull = new Float64Array(N), Y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (nodeKind[i] === 'tunnel') {
      const t = Math.min(1, toPortal[i]! / RAMP), ease = t * t * (3 - 2 * t);
      const depth = DEPTH + (nodeLayer[i]! <= -3 ? DEEP_EXTRA : 0);
      target[i] = ground[i]! + (low[i]! - depth - ground[i]!) * ease;
      pull[i] = 0.004;
    } else if (nodeKind[i] === 'bridge') {
      target[i] = ground[i]!;
      pull[i] = 0; // a straight line between its ends
    } else {
      target[i] = ground[i]!;
      pull[i] = 0.35;
    }
    Y[i] = target[i]!;
  }
  // Stations are level: the track points beside an underground platform, and those tied to them across the tracks,
  // all take the lowest of their target heights and keep it.
  {
    const beside = new Uint8Array(N);
    for (const pf of f.tunnelPlatforms) {
      const xs = pf.outline.map((q) => q.x), zs = pf.outline.map((q) => q.z);
      const x0 = Math.min(...xs) - 7, x1 = Math.max(...xs) + 7, z0 = Math.min(...zs) - 7, z1 = Math.max(...zs) + 7;
      for (let i = 0; i < N; i++) {
        if (nodeKind[i] !== 'tunnel' || NX[i]! < x0 || NX[i]! > x1 || NZ[i]! < z0 || NZ[i]! > z1) continue;
        // within 7 m of the outline
        for (let k = 0, m = pf.outline.length - 1; k < pf.outline.length; m = k++) {
          const a = pf.outline[m]!, b = pf.outline[k]!, ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
          const t = l2 > 0 ? Math.min(1, Math.max(0, ((NX[i]! - a.x) * ex + (NZ[i]! - a.z) * ez) / l2)) : 0;
          if (Math.hypot(a.x + ex * t - NX[i]!, a.z + ez * t - NZ[i]!) < 7) { beside[i] = 1; break; }
        }
      }
    }
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!beside[i] || seen[i]) continue;
      const group = [i];
      seen[i] = 1;
      for (let q = 0; q < group.length; q++) for (const j of adj[group[q]!]!) if (beside[j] && !seen[j]) { seen[j] = 1; group.push(j); }
      let level = Infinity;
      for (const j of group) level = Math.min(level, target[j]!);
      for (const j of group) { target[j] = level; pull[j] = 1; Y[j] = level; }
    }
  }
  for (let it = 0; it < 700; it++) {
    for (let i = 0; i < N; i++) {
      const a = adj[i]!;
      if (a.length === 0) continue;
      let s = 0;
      for (const j of a) s += Y[j]!;
      const avg = s / a.length;
      // a track's end (one neighbour) keeps to its target: nothing pulls it from the other side
      Y[i] = trackEnd[i] ? target[i]! : avg + (target[i]! - avg) * pull[i]!;
    }
  }
  for (const w of ways.values()) for (let i = 0; i < w.n; i++) w.y[i] = w.node[i]! >= 0 ? Y[w.node[i]!]! : NaN;

  // ---- tunnels: neighbours and platforms ----
  const tunnelWays = [...ways.values()].filter((w) => w.kind === 'tunnel');
  const grid = new Map<string, [Way, number][]>();
  const CELL = 6;
  for (const w of tunnelWays) {
    for (let i = 0; i < w.n; i++) {
      if (w.node[i]! < 0) continue;
      const k = `${Math.floor(w.x[i]! / CELL)}_${Math.floor(w.z[i]! / CELL)}`;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push([w, i]);
    }
  }
  /** The nearest other track beside point i of w on `side` (1 left, −1 right): its distance across and its way. */
  const neighbour = (w: Way, i: number, side: number, reach: number): { d: number; way: Way } | null => {
    const nx = w.fz[i]! * side, nz = -w.fx[i]! * side;
    let best: { d: number; way: Way } | null = null;
    const r = Math.ceil((reach + 2) / CELL);
    const cx = Math.floor(w.x[i]! / CELL), cz = Math.floor(w.z[i]! / CELL);
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gz = cz - r; gz <= cz + r; gz++) {
        for (const [o, j] of grid.get(`${gx}_${gz}`) ?? []) {
          if (o === w && Math.abs(j - i) < 40) continue;
          if (Math.abs(o.y[j]! - w.y[i]!) > 2.5) continue;
          const dx = o.x[j]! - w.x[i]!, dz = o.z[j]! - w.z[i]!;
          const along = dx * w.fx[i]! + dz * w.fz[i]!, across = dx * nx + dz * nz;
          if (Math.abs(along) > 1.3 || across < 0.4 || across > reach) continue;
          if (!best || across < best.d) best = { d: across, way: o };
        }
      }
    }
    return best;
  };
  const names: string[] = [];
  const platforms = f.tunnelPlatforms.map((p) => {
    const xs = p.outline.map((q) => q.x), zs = p.outline.map((q) => q.z);
    let n = names.indexOf(p.name);
    if (n < 0) n = names.push(p.name) - 1;
    return { ring: p.outline, name: n, minX: Math.min(...xs) - 1, maxX: Math.max(...xs) + 1, minZ: Math.min(...zs) - 1, maxZ: Math.max(...zs) + 1 };
  });
  for (const w of tunnelWays) {
    for (let i = 0; i < w.n; i++) {
      if (w.node[i]! < 0) continue;
      for (const s of [0, 1] as const) {
        const side = s === 0 ? 1 : -1, nx = w.fz[i]! * side, nz = -w.fx[i]! * side;
        // a platform beside the track: where the OSM outline begins and ends along the normal
        let d0 = 0, d1 = 0, name = -1;
        const near = platforms.filter((p) => w.x[i]! > p.minX - PLATFORM_REACH && w.x[i]! < p.maxX + PLATFORM_REACH && w.z[i]! > p.minZ - PLATFORM_REACH && w.z[i]! < p.maxZ + PLATFORM_REACH);
        if (near.length) {
          for (let u = 0.8; u <= PLATFORM_REACH; u += 0.25) {
            const q = { x: w.x[i]! + nx * u, z: w.z[i]! + nz * u };
            const hit = near.find((p) => q.x >= p.minX && q.x <= p.maxX && q.z >= p.minZ && q.z <= p.maxZ && pointInPolygon(q, p.ring));
            if (hit) { if (d0 === 0) { d0 = u; name = hit.name; } d1 = u; } else if (d0 > 0) break;
          }
        }
        const nb = neighbour(w, i, side, 24);
        if (d0 > 0 && d0 <= 2.6) {
          // an island if the next track lies right beyond the platform
          if (nb && nb.d - EDGE <= d1 + 1.5) {
            w.plat[s][i] = w.id < nb.way.id ? 2 : 3;
            w.far[s][i] = nb.d - EDGE;
          } else {
            w.plat[s][i] = 1;
            w.far[s][i] = Math.max(d1, EDGE + SIDE_PLATFORM_W);
          }
          w.name[s][i] = name;
          w.ext[s][i] = EDGE;
        } else if (nb && nb.d < 2 * WALL_CLEAR) {
          w.ext[s][i] = nb.d / 2;
        } else {
          w.ext[s][i] = WALL_CLEAR;
          w.wall[s][i] = 1;
        }
      }
    }
    // platforms: short gaps closed, short runs dropped, the width evened out
    for (const s of [0, 1] as const) {
      const plat = w.plat[s], far = w.far[s], name = w.name[s];
      for (let i = 1; i < w.n - 1; i++) {
        if (plat[i]) continue;
        let j = i;
        while (j < w.n && !plat[j]) j++;
        if (plat[i - 1] && j < w.n && j - i <= 4) {
          for (let k = i; k < j; k++) { plat[k] = plat[i - 1]!; far[k] = far[i - 1]!; name[k] = name[i - 1]!; w.ext[s][k] = EDGE; w.wall[s][k] = 0; }
        }
        i = j;
      }
      for (let i = 0; i < w.n; i++) {
        if (!plat[i]) continue;
        let j = i;
        while (j < w.n && plat[j] === plat[i]) j++;
        if (j - i < PLATFORM_MIN_RUN) {
          for (let k = i; k < j; k++) { plat[k] = 0; far[k] = 0; name[k] = -1; w.ext[s][k] = WALL_CLEAR; w.wall[s][k] = 1; }
        } else {
          const even = Array.from({ length: j - i }, (_, k) => {
            let sum = 0, cnt = 0;
            for (let m = Math.max(i, i + k - 4); m <= Math.min(j - 1, i + k + 4); m++) { sum += far[m]!; cnt++; }
            return sum / cnt;
          });
          for (let k = i; k < j; k++) far[k] = even[k - i]!;
        }
        i = j - 1;
      }
    }
    // light: bright along a platform, fading out into the tunnel
    for (let i = 0; i < w.n; i++) w.light[i] = w.plat[0][i] || w.plat[1][i] ? 1 : 0;
    for (let pass = 0; pass < 14; pass++) {
      for (let i = 0; i < w.n; i++) w.light[i] = Math.max(w.light[i]!, (i > 0 ? w.light[i - 1]! : 0) - 1 / 14, (i < w.n - 1 ? w.light[i + 1]! : 0) - 1 / 14);
    }
  }

  // ---- geometry ----
  const inside = new ColorMesh(), outside = new ColorMesh();
  const col: number[] = [];
  const solid = (a: V3, b: V3, c: V3, d: V3) => col.push(...a, ...b, ...c, ...a, ...c, ...d);
  const surface = (p: Pt): number => heightAt(terrain, p.x, p.z) + (env.pavement(p) ? PAVEMENT_H : 0);
  const openings: Pt[][] = [];
  const tonesOf = (name: number): RGB[] => STATION_LOOK[names[name] ?? '']?.tones ?? TILE_TONES;

  for (const w of tunnelWays) {
    /** A point at sample position `at` of this way, u metres to the left of the track, y above the rail top. */
    const P = (at: number, u: number, y: number): V3 => {
      const i = Math.min(w.n - 2, Math.max(0, Math.floor(at))), t = at - i;
      // (exactly on a sample: that sample alone. Its neighbour may lie outside the world and have no height)
      const j = t === 0 ? i : i + 1;
      const nx = w.fz[i]! + (w.fz[j]! - w.fz[i]!) * t, nz = -(w.fx[i]! + (w.fx[j]! - w.fx[i]!) * t);
      return [w.x[i]! + (w.x[j]! - w.x[i]!) * t + nx * u, w.y[i]! + (w.y[j]! - w.y[i]!) * t + y, w.z[i]! + (w.z[j]! - w.z[i]!) * t + nz * u];
    };
    const railAt = (at: number): number => {
      const i = Math.min(w.n - 2, Math.max(0, Math.floor(at)));
      return at === i ? w.y[i]! : w.y[i]! + (w.y[i + 1]! - w.y[i]!) * (at - i);
    };
    const xz = (v: V3): Pt => ({ x: v[0], z: v[2] });

    // stairs: one per platform (not the half of an island the other track builds), near one of its ends
    const stairs: { side: 0 | 1; stair: Stair }[] = [];
    for (const s of [0, 1] as const) {
      const sign = s === 0 ? 1 : -1;
      for (let i = 0; i < w.n; i++) {
        const kind = w.plat[s][i]!;
        if (kind !== 1 && kind !== 2) continue;
        let j = i;
        while (j < w.n && w.plat[s][j] === kind) j++;
        const i0 = i, i1 = j - 1, mid = Math.round((i0 + i1) / 2), far = w.far[s][mid]!;
        i = j - 1;
        if (i1 - i0 < 16) continue;
        let u0: number, u1: number;
        if (kind === 2) {
          if (far - EDGE < STAIR_W + 2.2) continue;
          u0 = (EDGE + far) / 2 - STAIR_W / 2;
          u1 = u0 + STAIR_W;
        } else {
          if (far - EDGE < STAIR_W + 1.4) continue;
          u0 = far - STAIR_W;
          u1 = far;
        }
        const candidates: (Stair & { score: number })[] = [];
        for (const end of [0, 1]) {
          const dir = end === 0 ? -1 : 1, edge = end === 0 ? i0 : i1, um = sign * (u0 + u1) / 2;
          const top = edge - dir * 2;
          const groundY = surface(xz(P(top, um, 0)));
          const rise = groundY - (w.y[top]! + PLATFORM_H);
          const run = Math.ceil(rise / STAIR_SLOPE / STEP), bottom = top - dir * run;
          if (!(rise >= 2) || bottom < i0 + 2 || bottom > i1 - 2) continue;
          const probes: Pt[] = [];
          for (let k = 0; k <= run; k++) for (const u of [u0, (u0 + u1) / 2, u1]) probes.push(xz(P(bottom + dir * k, sign * u, 0)));
          const out = xz(P(top + dir, um, 0));
          probes.push(out);
          if (probes.some((p) => env.built(p))) continue;
          const score = (env.pavement(out) ? 2 : 0) + (env.roadway(out) ? -2 : 0) + (probes.filter((p) => env.roadway(p)).length > probes.length / 2 ? -1 : 0)
            + (end === (w.id + s) % 2 ? 0.5 : 0);
          candidates.push({ u0: Math.min(sign * u0, sign * u1), u1: Math.max(sign * u0, sign * u1), bottom, top, topY: groundY, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        const c = candidates[0];
        if (c) stairs.push({ side: s, stair: { u0: c.u0, u1: c.u1, bottom: c.bottom, top: c.top, topY: c.topY } });
      }
    }

    for (let i = 0; i < w.n - 1; i++) {
      const j = i + 1;
      if (w.node[i]! < 0 || w.node[j]! < 0) continue;
      // near a portal the track is too shallow for a roof: no tunnel there (the train comes out of the ground)
      const depthI = heightAt(terrain, w.x[i]!, w.z[i]!) - w.y[i]!, depthJ = heightAt(terrain, w.x[j]!, w.z[j]!) - w.y[j]!;
      if (Math.min(depthI, depthJ) < CEIL + 0.3) continue;
      const li = Math.max(0.035, w.light[i]! ** 2), lj = Math.max(0.035, w.light[j]! ** 2), L: [number, number, number, number] = [li, lj, lj, li];
      const k = (f: number): [number, number, number, number] => [li * f, lj * f, lj * f, li * f];
      // signed reach to the left (+) and to the right (−): the track's own floor, and the hall's ceiling over a platform
      const eL = [w.ext[0][i]!, w.ext[0][j]!], eR = [-w.ext[1][i]!, -w.ext[1][j]!];
      const owns = (s: 0 | 1, at: number) => w.plat[s][at] === 1 || w.plat[s][at] === 2;
      const cL = [owns(0, i) ? w.far[0][i]! : eL[0]!, owns(0, j) ? w.far[0][j]! : eL[1]!];
      const cR = [owns(1, i) ? -w.far[1][i]! : eR[0]!, owns(1, j) ? -w.far[1][j]! : eR[1]!];
      const fl: [V3, V3, V3, V3] = [P(i, eR[0]!, FLOOR), P(j, eR[1]!, FLOOR), P(j, eL[1]!, FLOOR), P(i, eL[0]!, FLOOR)];
      inside.quad(...fl, COLORS.slab, L);
      solid(...fl);
      // the ceiling, left open over a stair
      const gaps = stairs.filter(({ stair: t }) => Math.min(t.bottom, t.top) <= i && j <= Math.max(t.bottom, t.top)).map(({ stair: t }) => [t.u0, t.u1] as [number, number]).sort((a, b) => a[0] - b[0]);
      const station = owns(0, i) || owns(1, i) || owns(0, j) || owns(1, j);
      let from: number | null = null;
      for (const [g0, g1] of [...gaps, [Infinity, Infinity] as [number, number]]) {
        const a = from === null ? cR : [from, from], b = Number.isFinite(g0) ? [g0, g0] : cL;
        const q: [V3, V3, V3, V3] = [P(i, a[0]!, CEIL), P(j, a[1]!, CEIL), P(j, b[1]!, CEIL), P(i, b[0]!, CEIL)];
        inside.quad(...q, station ? COLORS.panel : COLORS.ceiling, k(station ? 0.9 : 0.7));
        solid(...q);
        from = g1;
      }
      for (const r of [1, -1]) {
        const u = (r * GAUGE) / 2, h = RAIL_W / 2;
        inside.quad(P(i, u - h, 0), P(j, u - h, 0), P(j, u + h, 0), P(i, u + h, 0), COLORS.rail, L);
        inside.quad(P(i, u - h, FLOOR), P(j, u - h, FLOOR), P(j, u - h, 0), P(i, u - h, 0), COLORS.rail, k(0.5));
        inside.quad(P(i, u + h, FLOOR), P(j, u + h, FLOOR), P(j, u + h, 0), P(i, u + h, 0), COLORS.rail, k(0.5));
      }
      for (const s of [0, 1] as const) {
        const sign = s === 0 ? 1 : -1, e0 = sign * w.ext[s][i]!, e1 = sign * w.ext[s][j]!;
        const pi = w.plat[s][i]!, pj = w.plat[s][j]!;
        // the tunnel's wall where nothing adjoins
        if (w.wall[s][i] && w.wall[s][j]) {
          const q: [V3, V3, V3, V3] = [P(i, e0, FLOOR), P(j, e1, FLOOR), P(j, e1, CEIL), P(i, e0, CEIL)];
          inside.quad(...q, COLORS.wall, k(0.8));
          solid(...q);
        }
        if ((pi === 1 || pi === 2) && pi === pj) {
          const f0 = sign * w.far[s][i]!, f1 = sign * w.far[s][j]!, a0 = sign * EDGE, tones = tonesOf(w.name[s][i]!);
          // the slab: paving about a metre square in slightly different greys, its face to the track, the white line
          const top: [V3, V3, V3, V3] = [P(i, a0, PLATFORM_H), P(j, a0, PLATFORM_H), P(j, f1, PLATFORM_H), P(i, f0, PLATFORM_H)];
          solid(...top);
          const across = Math.max(1, Math.round(Math.abs(f0 - a0)));
          for (let m = 0; m < 2; m++) {
            for (let c = 0; c < across; c++) {
              const t0 = m / 2, t1 = (m + 1) / 2, g0 = c / across, g1 = (c + 1) / across;
              const u = (t: number, g: number) => a0 + (f0 + (f1 - f0) * t - a0) * g;
              const shade = 0.93 + 0.07 * hash(i * 2 + m, c, w.id + s);
              const l0 = (li + (lj - li) * t0) * shade, l1 = (li + (lj - li) * t1) * shade;
              inside.quad(P(i + t0, u(t0, g0), PLATFORM_H), P(i + t1, u(t1, g0), PLATFORM_H), P(i + t1, u(t1, g1), PLATFORM_H), P(i + t0, u(t0, g1), PLATFORM_H), COLORS.platform, [l0, l1, l1, l0]);
            }
          }
          const face: [V3, V3, V3, V3] = [P(i, a0, FLOOR), P(j, a0, FLOOR), P(j, a0, PLATFORM_H), P(i, a0, PLATFORM_H)];
          inside.quad(...face, COLORS.face, k(0.7));
          solid(...face);
          inside.quad(P(i, a0 + sign * 0.35, PLATFORM_H + 0.005), P(j, a0 + sign * 0.35, PLATFORM_H + 0.005), P(j, a0 + sign * 0.65, PLATFORM_H + 0.005), P(i, a0 + sign * 0.65, PLATFORM_H + 0.005), COLORS.edge, L);
          // the strip light over it
          const m0 = (a0 + f0) / 2, m1 = (a0 + f1) / 2;
          inside.quad(P(i, m0 - 0.1, CEIL - 0.05), P(j, m1 - 0.1, CEIL - 0.05), P(j, m1 + 0.1, CEIL - 0.05), P(i, m0 + 0.1, CEIL - 0.05), COLORS.light, 1);
          if (pi === 2) {
            // an island: its other face, towards the other track
            const other: [V3, V3, V3, V3] = [P(i, f0, FLOOR), P(j, f1, FLOOR), P(j, f1, PLATFORM_H), P(i, f0, PLATFORM_H)];
            inside.quad(...other, COLORS.face, k(0.7));
            solid(...other);
            inside.quad(P(i, f0 - sign * 0.35, PLATFORM_H + 0.005), P(j, f1 - sign * 0.35, PLATFORM_H + 0.005), P(j, f1 - sign * 0.65, PLATFORM_H + 0.005), P(i, f0 - sign * 0.65, PLATFORM_H + 0.005), COLORS.edge, L);
          } else {
            // the hall's back wall: upright tiles a hand wide, each column in a few pieces of different tones
            solid(P(i, f0, PLATFORM_H), P(j, f1, PLATFORM_H), P(j, f1, CEIL), P(i, f0, CEIL));
            const cols = Math.round(STEP / TILE_W);
            for (let c = 0; c < cols; c++) {
              const t0 = c / cols, t1 = (c + 1) / cols, w0 = f0 + (f1 - f0) * t0, w1 = f0 + (f1 - f0) * t1;
              const l0 = li + (lj - li) * t0, l1 = li + (lj - li) * t1;
              let y = PLATFORM_H;
              for (let piece = 0; y < CEIL - 1e-6; piece++) {
                const y1 = Math.min(CEIL, y + 0.35 + 1.5 * hash(i * 16 + c, piece, w.id + s));
                const tone = tones[Math.floor(hash(i * 16 + c, piece, w.id + s + 7) * tones.length)]!;
                inside.quad(P(i + t0, w0, y), P(i + t1, w1, y), P(i + t1, w1, y1), P(i + t0, w0, y1), tone, [l0, l1, l1, l0]);
                y = y1;
              }
            }
          }
        }
        // where a platform begins or ends: the slab's end and the hall's end wall beside the tunnel
        for (const [here, there, at] of [[pi, pj, i], [pj, pi, j]] as const) {
          if (!(here === 1 || here === 2) || here === there) continue;
          const a0 = sign * EDGE, f0 = sign * w.far[s][at]!, lt = Math.max(0.035, w.light[at]! ** 2);
          const slab: [V3, V3, V3, V3] = [P(at, a0, FLOOR), P(at, f0, FLOOR), P(at, f0, PLATFORM_H), P(at, a0, PLATFORM_H)];
          inside.quad(...slab, COLORS.face, lt * 0.6);
          solid(...slab);
          const end: [V3, V3, V3, V3] = [P(at, sign * WALL_CLEAR, PLATFORM_H), P(at, f0, PLATFORM_H), P(at, f0, CEIL), P(at, sign * WALL_CLEAR, CEIL)];
          if (Math.abs(f0) > WALL_CLEAR) { inside.quad(...end, tonesOf(w.name[s][at]!)[1]!, lt * 0.8); solid(...end); }
        }
      }
    }
    for (const { side, stair } of stairs) {
      const mid = Math.round((stair.bottom + stair.top) / 2);
      openings.push(buildStair({ P, rail: railAt, surface, inside, outside, solid, tone: tonesOf(w.name[side][mid]!)[1]! }, stair));
    }
  }

  // ---- the lines' paths and stops ----
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const stationNames: string[] = [], stationAt: { x: number; y: number; z: number }[] = [];
  const tracks: Transit['tracks'] = [];
  const anyPlatform = f.platforms;
  for (const r of routes) {
    // the path through the world: the longest run of points inside it
    type Pp = { x: number; y: number; z: number; way: Way; i: number };
    let run: Pp[] = [], best: Pp[] = [];
    const close = () => { if (run.length > best.length) best = run; run = []; };
    for (const part of r.parts) {
      const w = ways.get(part.way);
      if (!w) { close(); continue; }
      for (let q = 0; q < w.n; q++) {
        const i = part.reversed ? w.n - 1 - q : q;
        if (w.node[i]! < 0) { close(); continue; }
        const last = run[run.length - 1];
        if (last && Math.hypot(last.x - w.x[i]!, last.z - w.z[i]!) < 1e-3) continue; // the point shared with the way before
        run.push({ x: w.x[i]!, y: w.y[i]!, z: w.z[i]!, way: w, i });
      }
    }
    close();
    if (best.length < 60) continue;
    const cum = [0];
    for (let i = 1; i < best.length; i++) cum.push(cum[i - 1]! + Math.hypot(best[i]!.x - best[i - 1]!.x, best[i]!.y - best[i - 1]!.y, best[i]!.z - best[i - 1]!.z));
    const length = cum[cum.length - 1]!;
    const stops: Transit['tracks'][number]['stops'] = [];
    for (const st of r.stops) {
      let bi = -1, bd = 20;
      for (let i = 0; i < best.length; i++) { const d = Math.hypot(best[i]!.x - st.x, best[i]!.z - st.z); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0) continue;
      const s = cum[bi]!;
      // a train must fit before the first and after the last stop, and between two stops
      if (s < TRAIN_LENGTH / 2 + 6 || s > length - TRAIN_LENGTH / 2 - 6 || (stops.length && s - stops[stops.length - 1]!.s < TRAIN_LENGTH)) continue;
      const p = best[bi]!, w = p.way, fwd = (bi + 1 < best.length ? best[bi + 1]!.i : p.i) >= p.i ? 1 : -1;
      // the platform's side in the direction of travel: from the tunnel's platforms, else from any OSM platform nearby
      let side: 1 | -1 = -1;
      const left = w.plat[0][p.i]! > 0, right = w.plat[1][p.i]! > 0;
      if (left !== right) side = (left ? 1 : -1) * fwd as 1 | -1;
      else if (!left) {
        let near = 9, across = 0;
        for (const line of anyPlatform) {
          for (const q of line) {
            const d = Math.hypot(q.x - p.x, q.z - p.z);
            if (d < near) { near = d; across = (q.x - p.x) * w.fz[p.i]! - (q.z - p.z) * w.fx[p.i]!; }
          }
        }
        if (across !== 0) side = (across > 0 ? 1 : -1) * fwd as 1 | -1;
      }
      let station = stationNames.indexOf(st.name);
      if (station < 0) {
        station = stationNames.push(st.name) - 1;
        stationAt.push({ x: r2(p.x), y: r2(p.y + PLATFORM_H), z: r2(p.z) });
      }
      const under = w.kind === 'tunnel' && (left || right);
      stops.push({ station, s: r2(s), side, ...(under ? { under: true } : {}) });
    }
    if (stops.length === 0) continue;
    // thinned: a point is kept where leaving it out would move the path by more than 3 cm (stops stay exact enough)
    const keep: number[] = [0];
    for (let i = 1; i < best.length - 1; i++) {
      const a = best[keep[keep.length - 1]!]!, b = best[i + 1]!, p = best[i]!;
      const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z, l2 = ex * ex + ey * ey + ez * ez;
      const t = l2 > 0 ? ((p.x - a.x) * ex + (p.y - a.y) * ey + (p.z - a.z) * ez) / l2 : 0;
      if (Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y, a.z + ez * t - p.z) > 0.03 || i - keep[keep.length - 1]! >= 12) keep.push(i);
    }
    keep.push(best.length - 1);
    tracks.push({ pts: keep.flatMap((i) => [r2(best[i]!.x), r2(best[i]!.y), r2(best[i]!.z)]), stops, line: r.ref, to: r.to.replace(/^Köln[- ]/, '') });
  }
  if (tracks.length === 0) return null;

  spreadDepartures(tracks);
  const transit: Transit = {
    headway: HEADWAY,
    stations: stationNames.map((name, i) => ({ name, ...stationAt[i]! })),
    tracks,
    openings: openings.map((ring) => ring.flatMap((p) => [r2(p.x), r2(p.z)])),
  };
  // which underground stations got no way up (their platforms are too narrow or too short for a stair)
  {
    const withStair = new Set<number>();
    for (const ring of openings) {
      const c = ring[0]!;
      let best = -1, bd = 120;
      stationAt.forEach((p, i) => { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) withStair.add(best);
    }
    const under = new Set(tracks.flatMap((t) => t.stops.filter((st) => st.under).map((st) => st.station)));
    const none = [...under].filter((i) => !withStair.has(i)).map((i) => stationNames[i]);
    if (none.length) console.log(`transit: no stair at ${none.join(', ')}`);
  }
  const tunnelM = tunnelWays.reduce((n, w) => n + (w.n - 1) * STEP, 0);
  console.log(`transit: ${tracks.length} line paths, ${stationNames.length} stations (${names.length} underground with platforms), ${(tunnelM / 1000).toFixed(1)} km tunnel track, ${openings.length} stairs`);
  // (a single value that is not a number would shift everything after it in the encoded collision)
  const bad = col.findIndex((v) => !Number.isFinite(v));
  if (bad >= 0) throw new Error(`transit: collision vertex ${Math.floor(bad / 3)} is not a finite number`);
  return { transit, models: await encodeModels(inside, outside), collision: Float32Array.from(col), openings };
}

/** Two trains at one platform are at least this far apart (s): a train stands there for 22 s, and the next keeps its distance. */
const MIN_GAP = 110;

/**
 * A makeshift timetable until the real one: every line path gets a headway and a shift of its departures such that no
 * two trains meet at a platform. Paths of one line that share their platforms (its branches: 12 to Merkenich and to
 * Niehl) take turns in the line's HEADWAY; then each path, one after the other, gets the shift that keeps its trains
 * furthest in time from those already placed, at every platform they share.
 */
function spreadDepartures(tracks: Transit['tracks']): void {
  const model = transitModel({ headway: HEADWAY, stations: [], tracks, openings: [] });
  // the platforms of a path: where its stops are (paths on the same track have the same points) → arrival time
  const at = tracks.map((tr, k) => {
    const m = new Map<string, number>(), cum = [0];
    for (let i = 3; i < tr.pts.length; i += 3) cum.push(cum[cum.length - 1]! + Math.hypot(tr.pts[i]! - tr.pts[i - 3]!, tr.pts[i + 1]! - tr.pts[i - 2]!, tr.pts[i + 2]! - tr.pts[i - 1]!));
    tr.stops.forEach((st, j) => {
      const i = Math.max(0, cum.findIndex((c) => c >= st.s));
      m.set(`${Math.round(tr.pts[i * 3]! / 6)}_${Math.round(tr.pts[i * 3 + 2]! / 6)}`, model.tracks[k]!.periodic!.profile.at[j]?.t0 ?? 0);
    });
    return m;
  });
  const shared = (a: number, b: number): string[] => [...at[a]!.keys()].filter((key) => at[b]!.has(key));
  tracks.forEach((tr, k) => {
    const branches = tracks.filter((o, j) => o.line === tr.line && shared(k, j).length >= 3).length;
    tr.headway = HEADWAY * Math.max(1, branches);
  });
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const placed: number[] = [];
  let worst = Infinity;
  tracks.forEach((tr, k) => {
    let best = 0, bestGap = -1;
    for (let phase = 0; phase < tr.headway!; phase += 10) {
      let gap = Infinity;
      for (const j of placed) {
        const o = tracks[j]!, period = gcd(tr.headway!, o.headway!);
        for (const key of shared(k, j)) {
          const d = ((((phase + at[k]!.get(key)!) - (o.phase! + at[j]!.get(key)!)) % period) + period) % period;
          gap = Math.min(gap, d, period - d);
        }
      }
      if (gap > bestGap) [best, bestGap] = [phase, gap];
    }
    tr.phase = best;
    placed.push(k);
    if (bestGap < worst) worst = bestGap;
  });
  if (worst < MIN_GAP) console.warn(`transit: two trains come within ${worst.toFixed(0)} s of each other at a platform (wanted: ${MIN_GAP} s)`);
  else console.log(`transit: departures spread; trains at a shared platform are at least ${Number.isFinite(worst) ? worst.toFixed(0) : '∞'} s apart`);
}
