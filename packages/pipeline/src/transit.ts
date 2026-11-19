import { CHUNK_SIZE, chunkKey, heightAt, STATION, type TerrainGrid, type Transit } from '@nn/shared';
import { Document, NodeIO, type TypedArray } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import type { OsmFeatures, Pt } from './osm.js';
import type { CityEnv } from './transitenv.js';

/**
 * The underground Stadtbahn, built from OSM: the two tunnel tracks of a line become one tunnel box around their
 * centre line, with stations (side platforms where the tracks run together, an island platform where they are apart),
 * stairs up to the street and the openings in the ground for them. Prototype: one line, see LINES.
 */
export type Line = {
  /** OSM way ids of the two tracks, each in travel order (any orientation: they are joined end to end). */
  tracks: [number[], number[]];
  /** Stations south to north as named on the OSM platforms; `level` picks the platforms of this line where a station has several. */
  stations: { name: string; level?: string }[];
  /** The line is cut here (local z; the play area ends a little further north). */
  northEndZ: number;
};

/** Lines 12/15 under Neusser Straße: Ebertplatz – Lohsestraße – Florastraße – Neusser Straße/Gürtel. */
export const LINES: Line[] = [{
  tracks: [[119300325, 789706483, 308899498, 308601431], [245124096, 916202576, 916202577]],
  stations: [{ name: 'Ebertplatz', level: '-2.5' }, { name: 'Lohsestraße' }, { name: 'Florastraße' }, { name: 'Neusser Straße/Gürtel' }],
  northEndZ: -1185,
}];

/** Seconds between two trains per direction (lines 12 and 15 together run about this often by day). */
const HEADWAY = 150;
/** Sample spacing along the line (m). */
export const STEP = 2;
/** Rail top below the lowest ground above the tunnel (m). */
export const DEPTH = 6.3;
/** Inner ceiling above the rail top, floor (slab) below it. */
export const CEIL = STATION.ceiling, FLOOR = -0.16;
/** Tunnel wall beyond the outer track's centre; platform edge from a track's centre; side platform width; platform height. */
export const WALL_CLEAR = STATION.wallClear, EDGE = STATION.edge, PLATFORM_W = STATION.platformWidth, PLATFORM_H = 0.35;
/** Tracks this far apart (half the distance) have an island platform between them. */
const ISLAND_MIN_H = 4;
/** A station's platform length (m): at least / at most. */
const PLATFORM_MIN = 66, PLATFORM_MAX = 84;
/** The tunnel goes on this far beyond the first station, the tracks back together (trains start and end out of sight). */
const STUB = 150, STUB_KEEP = 46, STUB_TAPER = 50;
export const GAUGE = 1.435, RAIL_W = 0.07;
/** Stairs: width, the steepest rise per metre, a step's height; walls stand this high above the pavement around the opening. */
export const STAIR_W = 2.4, STAIR_SLOPE = 0.56, STEP_H = 0.165, PARAPET = 1.05, PARAPET_T = 0.3;
/** Kerb height of the pavement (streets.ts CURB_H). */
export const PAVEMENT_H = 0.12;

export type V3 = [number, number, number];
export type RGB = [number, number, number];

/** Triangles with a colour per vertex. */
export class ColorMesh {
  pos: number[] = [];
  col: number[] = [];
  quad(a: V3, b: V3, c: V3, d: V3, color: RGB, light: [number, number, number, number] | number = 1): void {
    const l = typeof light === 'number' ? [light, light, light, light] : light;
    const v = [a, b, c, d];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.pos.push(...v[i]!);
      // colours and light are chosen as seen (sRGB); glTF vertex colours are linear
      this.col.push((color[0] * l[i]!) ** 2.2, (color[1] * l[i]!) ** 2.2, (color[2] * l[i]!) ** 2.2);
    }
  }
  /** An axis-aligned box in a local frame given by its 8 corners (bottom ring, then top ring, same order). */
  box(c: V3[], color: RGB, light = 1): void {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(c[i]!, c[j]!, c[4 + j]!, c[4 + i]!, color, light * (i % 2 ? 0.85 : 0.7));
    }
    this.quad(c[4]!, c[5]!, c[6]!, c[7]!, color, light);
    this.quad(c[3]!, c[2]!, c[1]!, c[0]!, color, light * 0.5);
  }
}

export const COLORS = {
  slab: [0.2, 0.19, 0.18] as RGB, rail: [0.55, 0.56, 0.58] as RGB, wall: [0.5, 0.5, 0.48] as RGB, ceiling: [0.3, 0.3, 0.3] as RGB,
  panel: [0.8, 0.79, 0.73] as RGB, joint: [0.42, 0.42, 0.4] as RGB, column: [0.86, 0.86, 0.82] as RGB, fence: [0.6, 0.61, 0.62] as RGB,
  bench: [0.92, 0.92, 0.9] as RGB, bin: [0.82, 0.16, 0.1] as RGB, signal: [1, 0.12, 0.06] as RGB,
  platform: [0.6, 0.6, 0.58] as RGB, edge: [0.95, 0.95, 0.92] as RGB, face: [0.36, 0.36, 0.35] as RGB, light: [1, 0.98, 0.9] as RGB,
  stair: [0.56, 0.56, 0.54] as RGB, concrete: [0.62, 0.62, 0.6] as RGB, sign: [0.05, 0.25, 0.7] as RGB, post: [0.25, 0.26, 0.28] as RGB,
};
/**
 * Station walls: narrow upright tiles in mixed grey-green and brown tones, as in the stations under Neusser Straße
 * (Florastraße). Each station tints them a little differently.
 */
export const TILE_TONES: RGB[] = [[0.47, 0.5, 0.44], [0.55, 0.58, 0.51], [0.4, 0.43, 0.38], [0.62, 0.64, 0.57], [0.34, 0.29, 0.24], [0.5, 0.53, 0.47]];
const tinted = (t: RGB): RGB[] => TILE_TONES.map((c) => [c[0] * t[0], c[1] * t[1], c[2] * t[2]] as RGB);
/**
 * Tile tones per station (by name; others get the plain mix) and an accent colour for a band on its columns:
 * Neusser Straße/Gürtel has pale yellow and dark blue tiles and blue on the columns.
 */
export const STATION_LOOK: Record<string, { tones: RGB[]; accent?: RGB }> = {
  Ebertplatz: { tones: tinted([1.08, 1, 0.9]) },
  'Lohsestraße': { tones: tinted([0.96, 1, 1.08]) },
  'Neusser Straße/Gürtel': {
    tones: [[0.8, 0.74, 0.46], [0.72, 0.66, 0.4], [0.86, 0.8, 0.54], [0.78, 0.72, 0.44], [0.2, 0.24, 0.38], [0.29, 0.33, 0.46], [0.4, 0.43, 0.5]],
    accent: [0.2, 0.3, 0.56],
  },
};
export const TILE_W = 0.125;
/** Deterministic 0..1 from integers (tile colours, paving shades). */
export function hash(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export type TransitBuild = {
  transit: Transit;
  /** The rendered models, one per chunk the line touches. */
  models: Map<string, Uint8Array>;
  /** Collision triangles (9 floats each). */
  collision: Float32Array;
  /** Openings in the ground (rings of points): cut out of the rendered ground, the pavement and its collision. */
  openings: Pt[][];
};

type Env = CityEnv & { terrain: TerrainGrid };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

/** Ways joined end to end (each turned as needed). */
function chain(ids: number[], ways: Map<number, Pt[]>): Pt[] {
  const parts = ids.map((id) => ways.get(id) ?? fail(`transit: OSM way ${id} is missing`));
  let out = [...parts[0]!];
  if (parts[1]) {
    const next = parts[1];
    const endFits = Math.min(dist(out[out.length - 1]!, next[0]!), dist(out[out.length - 1]!, next[next.length - 1]!));
    const startFits = Math.min(dist(out[0]!, next[0]!), dist(out[0]!, next[next.length - 1]!));
    if (startFits < endFits) out.reverse();
  }
  for (const p of parts.slice(1)) {
    const end = out[out.length - 1]!;
    const q = dist(end, p[0]!) <= dist(end, p[p.length - 1]!) ? p : [...p].reverse();
    if (dist(end, q[0]!) > 1) fail('transit: track ways do not join');
    out = out.concat(q.slice(1));
  }
  return out;
}

function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]!];
  let need = step;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, len = dist(a, b);
    let at = 0;
    while (len - at >= need) {
      at += need;
      out.push({ x: a.x + ((b.x - a.x) * at) / len, z: a.z + ((b.z - a.z) * at) / len });
      need = step;
    }
    need -= len - at;
  }
  return out;
}

/** Moving average over ±r samples (the window shrinks towards the ends, which stay put). */
function smooth(v: number[], r: number, passes = 2): number[] {
  let a = v;
  for (let p = 0; p < passes; p++) {
    const b = new Array<number>(a.length);
    for (let i = 0; i < a.length; i++) {
      const k = Math.min(r, i, a.length - 1 - i);
      let s = 0;
      for (let j = i - k; j <= i + k; j++) s += a[j]!;
      b[i] = s / (2 * k + 1);
    }
    a = b;
  }
  return a;
}
const smoothPts = (pts: Pt[], r: number): Pt[] => {
  const x = smooth(pts.map((p) => p.x), r), z = smooth(pts.map((p) => p.z), r);
  return pts.map((_, i) => ({ x: x[i]!, z: z[i]! }));
};

/** Nearest point on the polyline, and whether it is one of its ends. */
function nearest(p: Pt, line: Pt[]): { q: Pt; d: number; atEnd: boolean } {
  let best = { q: line[0]!, d: Infinity, atEnd: true };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!, ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ex + (p.z - a.z) * ez) / l2)) : 0;
    const q = { x: a.x + ex * t, z: a.z + ez * t }, d = dist(p, q);
    if (d < best.d) best = { q, d, atEnd: (i === 1 && t === 0) || (i === line.length - 1 && t === 1) };
  }
  return best;
}

type Station = { name: string; i0: number; i1: number; island: boolean; tones: RGB[]; accent?: RGB; stairs: Stair[] };

/** What a stair is built into: the cross-section along its track, the rail's height there, the ground above and the meshes. */
export type StairSite = {
  /** A point at sample position `at` (may be fractional), u metres across and y above the rail top there. */
  P(at: number, u: number, y: number): V3;
  /** The rail top's height at sample position `at`. */
  rail(at: number): number;
  /** Height of the walkable ground at a point (terrain, plus the kerb on pavement). */
  surface(p: Pt): number;
  inside: ColorMesh; outside: ColorMesh;
  /** Adds a quad to the collision. */
  solid(a: V3, b: V3, c: V3, d: V3): void;
  /** The shaft's wall colour (a tile tone of the station). */
  tone: RGB;
};
/** A stair from a platform up to the street: across u0..u1, from sample `bottom` to sample `top`, its top at height topY. */
export type Stair = { u0: number; u1: number; bottom: number; top: number; topY: number };

/**
 * Builds a stair with its shaft and the walls around its opening; returns the opening in the ground (its footprint, a
 * little beyond its top and half under the walls, which hide the ragged edge of the cut).
 */
export function buildStair(site: StairSite, t: Stair): Pt[] {
  const { P, rail, surface, inside, outside, solid, tone } = site;
  const xz = (v: V3): Pt => ({ x: v[0], z: v[2] });
  const dir = Math.sign(t.top - t.bottom), run = Math.abs(t.top - t.bottom);
  const y0 = PLATFORM_H, at = (k: number) => t.bottom + dir * k;
  /** Height above the rail top (at the stair's top end the rail differs a little: all heights relative to the bottom's). */
  const base = rail(t.bottom), rel = (k: number, y: number): number => y + base - rail(at(k));
  const rise = t.topY - (base + y0);
  const steps = Math.max(1, Math.round(rise / STEP_H)), h = rise / steps, d = run / steps;
  const Q = (k: number, u: number, y: number): V3 => P(at(k), u, rel(k, y));
  for (let k = 0; k < steps; k++) {
    // Up to the station's ceiling the steps lie in its light (fading towards the shaft); above it, in the shaft,
    // they and the shaft's walls are lit like everything outdoors: by the day, and dark at night.
    const yk = y0 + (k + 1) * h, up = Math.min(1, (yk - y0) / (CEIL - y0)), outdoors = yk > CEIL - 0.2;
    const mesh = outdoors ? outside : inside, l = outdoors ? 1 : 1 - 0.75 * up * up;
    mesh.quad(Q(k * d, t.u0, yk - h), Q(k * d, t.u1, yk - h), Q(k * d, t.u1, yk), Q(k * d, t.u0, yk), COLORS.stair, l * 0.7);
    mesh.quad(Q(k * d, t.u0, yk), Q(k * d, t.u1, yk), Q((k + 1) * d, t.u1, yk), Q((k + 1) * d, t.u0, yk), COLORS.stair, l);
    // the step's cheeks: closed down to the platform on both sides
    for (const u of [t.u0, t.u1]) inside.quad(Q(k * d, u, y0), Q((k + 1) * d, u, y0), Q((k + 1) * d, u, yk), Q(k * d, u, yk), COLORS.face, 0.8);
  }
  // walked on as a ramp through the middle of the steps
  for (let k = 0; k < run; k++) {
    const ya = y0 + (rise * k) / run + h / 2, yb = y0 + (rise * (k + 1)) / run + h / 2;
    solid(Q(k, t.u0, ya), Q(k, t.u1, ya), Q(k + 1, t.u1, yb), Q(k + 1, t.u0, yb));
  }
  // closed below (both sides and the high end), the shaft above the ceiling, walls around the opening
  const wallU = [t.u0, t.u1];
  for (let k = 0; k < run; k++) {
    const ya = y0 + (rise * k) / run, yb = y0 + (rise * (k + 1)) / run;
    for (const u of wallU) {
      const under: [V3, V3, V3, V3] = [Q(k, u, y0), Q(k + 1, u, y0), Q(k + 1, u, yb), Q(k, u, ya)];
      solid(...under);
      const ga = surface(xz(Q(k, u, 0))) - base, gb = surface(xz(Q(k + 1, u, 0))) - base;
      const shaft: [V3, V3, V3, V3] = [Q(k, u, CEIL), Q(k + 1, u, CEIL), Q(k + 1, u, gb), Q(k, u, ga)];
      outside.quad(...shaft, tone, 0.9);
      const full: [V3, V3, V3, V3] = [Q(k, u, CEIL), Q(k + 1, u, CEIL), Q(k + 1, u, gb + PARAPET), Q(k, u, ga + PARAPET)];
      solid(...full);
      // the wall around the opening: inner face, outer face and top
      const o = u === t.u0 ? -PARAPET_T : PARAPET_T;
      const oa = surface(xz(Q(k, u + o, 0))) - base, ob = surface(xz(Q(k + 1, u + o, 0))) - base;
      outside.quad(Q(k, u, ga), Q(k + 1, u, gb), Q(k + 1, u, gb + PARAPET), Q(k, u, ga + PARAPET), COLORS.concrete, 0.9);
      outside.quad(Q(k, u + o, oa - 0.3), Q(k + 1, u + o, ob - 0.3), Q(k + 1, u + o, gb + PARAPET), Q(k, u + o, ga + PARAPET), COLORS.concrete, 0.9);
      outside.quad(Q(k, u, ga + PARAPET), Q(k + 1, u, gb + PARAPET), Q(k + 1, u + o, gb + PARAPET), Q(k, u + o, ga + PARAPET), COLORS.concrete, 1);
      solid(Q(k, u + o, oa - 0.3), Q(k + 1, u + o, ob - 0.3), Q(k + 1, u + o, gb + PARAPET), Q(k, u + o, ga + PARAPET));
    }
  }
  for (const u of wallU) {
    // the walls' ends at the way in (they are hollow: an inner and an outer face)
    const o = u === t.u0 ? -PARAPET_T : PARAPET_T, g = surface(xz(Q(run, u, 0))) - base;
    outside.quad(Q(run, u, g - 0.3), Q(run, u + o, g - 0.3), Q(run, u + o, g + PARAPET), Q(run, u, g + PARAPET), COLORS.concrete, 0.8);
    solid(Q(run, u, g - 0.3), Q(run, u + o, g - 0.3), Q(run, u + o, g + PARAPET), Q(run, u, g + PARAPET));
  }
  {
    // the landing at the top: over the edge of the cut in the pavement, a finger's width above it
    const far = run + 0.7 / STEP, lift = 0.015;
    const q: [V3, V3, V3, V3] = [Q(run, t.u0 - PARAPET_T, y0 + rise + lift), Q(run, t.u1 + PARAPET_T, y0 + rise + lift), Q(far, t.u1 + PARAPET_T, y0 + rise + lift), Q(far, t.u0 - PARAPET_T, y0 + rise + lift)];
    outside.quad(...q, COLORS.stair, 1);
    solid(...q);
  }
  {
    // the high end below the stair, and the low end's wall from the ceiling up
    const end: [V3, V3, V3, V3] = [Q(run, t.u0, y0), Q(run, t.u1, y0), Q(run, t.u1, y0 + rise), Q(run, t.u0, y0 + rise)];
    inside.quad(...end, COLORS.face, 0.8);
    solid(...end);
    const g0 = surface(xz(Q(0, t.u0, 0))) - base, g1 = surface(xz(Q(0, t.u1, 0))) - base;
    outside.quad(Q(0, t.u0, CEIL), Q(0, t.u1, CEIL), Q(0, t.u1, g1), Q(0, t.u0, g0), tone, 0.85);
    solid(Q(0, t.u0, CEIL), Q(0, t.u1, CEIL), Q(0, t.u1, g1 + PARAPET), Q(0, t.u0, g0 + PARAPET));
    const b = -PARAPET_T / STEP; // the wall's thickness in samples
    outside.quad(Q(0, t.u0 - PARAPET_T, g0), Q(0, t.u1 + PARAPET_T, g1), Q(0, t.u1 + PARAPET_T, g1 + PARAPET), Q(0, t.u0 - PARAPET_T, g0 + PARAPET), COLORS.concrete, 0.85);
    outside.quad(Q(b, t.u0 - PARAPET_T, g0 - 0.3), Q(b, t.u1 + PARAPET_T, g1 - 0.3), Q(b, t.u1 + PARAPET_T, g1 + PARAPET), Q(b, t.u0 - PARAPET_T, g0 + PARAPET), COLORS.concrete, 0.85);
    outside.quad(Q(0, t.u0 - PARAPET_T, g0 + PARAPET), Q(0, t.u1 + PARAPET_T, g1 + PARAPET), Q(b, t.u1 + PARAPET_T, g1 + PARAPET), Q(b, t.u0 - PARAPET_T, g0 + PARAPET), COLORS.concrete, 1);
    solid(Q(b, t.u0 - PARAPET_T, g0 - 0.3), Q(b, t.u1 + PARAPET_T, g1 - 0.3), Q(b, t.u1 + PARAPET_T, g1 + PARAPET), Q(b, t.u0 - PARAPET_T, g0 + PARAPET));
    // the sign: a post with a blue cube at the way in
    const sx = t.u1 + PARAPET_T + 0.25, sk = run + 0.2 / STEP, gy = surface(xz(Q(sk, sx, 0))) - base;
    const ring = (y: number, r: number): V3[] => [Q(sk - r / STEP, sx - r, y), Q(sk + r / STEP, sx - r, y), Q(sk + r / STEP, sx + r, y), Q(sk - r / STEP, sx + r, y)];
    outside.box([...ring(gy, 0.06), ...ring(gy + 3, 0.06)], COLORS.post);
    outside.box([...ring(gy + 3, 0.4), ...ring(gy + 3.8, 0.4)], COLORS.sign);
  }
  // the opening in the ground: the stair's footprint, a little beyond its top and half under the walls around it
  // (which hide the ragged edge of the cut)
  const ring: Pt[] = [];
  const reach = run + 0.4 / STEP, under = PARAPET_T / 2, first = -under / STEP;
  for (let k = 0; k <= run; k++) ring.push(xz(Q(k === run ? reach : k === 0 ? first : k, t.u0 - under, 0)));
  for (let k = run; k >= 0; k--) ring.push(xz(Q(k === run ? reach : k === 0 ? first : k, t.u1 + under, 0)));
  return ring;
}

export async function buildTransit(f: OsmFeatures, env: Env, line: Line = LINES[0]!): Promise<TransitBuild | null> {
  const ways = new Map(f.tunnelTracks.map((w) => [w.id, w.pts]));
  if (!line.tracks.flat().every((id) => ways.has(id))) return null;
  const { terrain } = env;

  // both tracks south → north, cut at the northern end, as smooth 2 m polylines
  const prep = (ids: number[]): Pt[] => {
    let pts = chain(ids, ways);
    if (pts[0]!.z < pts[pts.length - 1]!.z) pts.reverse(); // north is −z
    const cut = pts.findIndex((p) => p.z < line.northEndZ);
    if (cut > 0) {
      const a = pts[cut - 1]!, b = pts[cut]!, t = (line.northEndZ - a.z) / (b.z - a.z);
      pts = [...pts.slice(0, cut), { x: a.x + (b.x - a.x) * t, z: line.northEndZ }];
    }
    return smoothPts(resample(pts, STEP), 6);
  };
  const east = prep(line.tracks[0]), west = prep(line.tracks[1]);

  // the centre line between them and half their distance, where both exist side by side
  let mid: Pt[] = [], half: number[] = [];
  for (const p of east) {
    const n = nearest(p, west);
    if (n.atEnd) continue;
    mid.push({ x: (p.x + n.q.x) / 2, z: (p.z + n.q.z) / 2 });
    half.push(n.d / 2);
  }
  if (mid.length < 20) return null;
  // south of that: straight on for the first station and a stub the trains start in, the tracks coming together
  {
    const a = mid[0]!, b = mid[8]!, len = dist(a, b), dx = (a.x - b.x) / len, dz = (a.z - b.z) / len, h0 = half[0]!;
    const ext: Pt[] = [], extH: number[] = [];
    for (let s = STEP; s <= STUB; s += STEP) {
      ext.unshift({ x: a.x + dx * s, z: a.z + dz * s });
      const t = Math.min(1, Math.max(0, (s - STUB_KEEP) / STUB_TAPER));
      extH.unshift(h0 + (Math.min(h0, WALL_CLEAR - 0.3) - h0) * (t * t * (3 - 2 * t)));
    }
    mid = [...ext, ...mid];
    half = [...extH, ...half];
  }
  {
    // even spacing again (the centre line is shorter than the outer track in curves)
    const cum = [0];
    for (let i = 1; i < mid.length; i++) cum.push(cum[i - 1]! + dist(mid[i - 1]!, mid[i]!));
    const even = resample(mid, STEP), h: number[] = [];
    let j = 0;
    even.forEach((_, i) => {
      const s = i * STEP;
      while (j + 2 < cum.length && cum[j + 1]! < s) j++;
      const t = Math.min(1, Math.max(0, (s - cum[j]!) / Math.max(1e-6, cum[j + 1]! - cum[j]!)));
      h.push(half[j]! + (half[j + 1]! - half[j]!) * t);
    });
    mid = even;
    half = smooth(h, 4);
  }
  const n = mid.length;
  /** Left of the direction of travel north (unit). */
  const normal: Pt[] = mid.map((_, i) => {
    const a = mid[Math.max(0, i - 1)]!, b = mid[Math.min(n - 1, i + 1)]!, len = dist(a, b);
    const fx = (b.x - a.x) / len, fz = (b.z - a.z) / len;
    return { x: fz, z: -fx }; // forward (sin h, cos h) → left (cos h, −sin h)
  });

  // stations: where the OSM platforms lie along the centre line
  const stations: Station[] = [];
  line.stations.forEach((st) => {
    const outlines = f.tunnelPlatforms.filter((p) => p.name === st.name && (st.level === undefined || p.level === st.level));
    let lo = Infinity, hi = -Infinity;
    for (const o of outlines) {
      for (const p of o.outline) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < n; i++) { const d = dist(p, mid[i]!); if (d < bd) { bd = d; best = i; } }
        if (bd > 30) continue;
        lo = Math.min(lo, best);
        hi = Math.max(hi, best);
      }
    }
    if (!Number.isFinite(lo)) return fail(`transit: no platform found for ${st.name}`);
    const min = Math.ceil(PLATFORM_MIN / STEP), max = Math.floor(PLATFORM_MAX / STEP);
    let c = Math.round((lo + hi) / 2), len = Math.min(max, Math.max(min, hi - lo));
    const margin = Math.ceil(80 / STEP); // room for a train beyond the last platform
    c = Math.min(n - 1 - margin - len / 2, Math.max(margin + len / 2, c));
    const i0 = Math.round(c - len / 2), i1 = i0 + len;
    stations.push({ name: st.name, i0, i1, island: half[Math.round(c)]! >= ISLAND_MIN_H, tones: STATION_LOOK[st.name]?.tones ?? TILE_TONES, accent: STATION_LOOK[st.name]?.accent, stairs: [] });
  });
  const stationAt = (i: number): Station | undefined => stations.find((s) => i >= s.i0 && i <= s.i1);
  // Between the tracks of a station with side platforms stands a row of columns: the tracks at least COLUMN_HALF from
  // the centre line there (OSM draws them closer than they are), spread out and back over SPREAD samples either side.
  {
    const COLUMN_HALF = 2.0, SPREAD = 20, wide = [...half];
    for (const s of stations) {
      if (s.island) continue;
      for (let i = Math.max(0, s.i0 - SPREAD); i <= Math.min(n - 1, s.i1 + SPREAD); i++) {
        const t = Math.min(1, Math.max(0, i < s.i0 ? (i - (s.i0 - SPREAD)) / SPREAD : i > s.i1 ? (s.i1 + SPREAD - i) / SPREAD : 1)), w = t * t * (3 - 2 * t);
        wide[i] = Math.max(wide[i]!, half[i]! + (Math.max(half[i]!, COLUMN_HALF) - half[i]!) * w);
      }
    }
    for (let i = 0; i < n; i++) half[i] = wide[i]!;
  }
  /** Inner half-width of the tunnel at sample i. */
  const width = (i: number): number => {
    const s = stationAt(i);
    return half[i]! + (s && !s.island ? EDGE + PLATFORM_W : WALL_CLEAR);
  };

  // height: under the lowest ground above the tunnel, smoothed (a train does not follow every dip)
  const groundMin = mid.map((p, i) => {
    let g = Infinity;
    const w = width(i) + 1;
    for (let u = -w; u <= w; u += 2) g = Math.min(g, heightAt(terrain, p.x + normal[i]!.x * u, p.z + normal[i]!.z * u));
    return g;
  });
  // The lowest ground within ±LOW_REACH along the line, averaged twice over half that reach: every value averaged
  // lies within reach, so the result never rises above the ground over it, and it has no kinks (no bumps in the ride).
  const LOW_REACH = 60, AVG = LOW_REACH / 2;
  const lowest = groundMin.map((_, i) => {
    let g = Infinity;
    for (let j = Math.max(0, i - LOW_REACH); j <= Math.min(n - 1, i + LOW_REACH); j++) g = Math.min(g, groundMin[j]!);
    return g;
  });
  const rail = smooth(lowest, AVG).map((g) => g - DEPTH);
  // platforms are level: the lowest point of the line around them, eased in and out over EASE samples either side
  {
    const EASE = 40, line = [...rail];
    for (const s of stations) {
      const a = Math.max(0, s.i0 - EASE), b = Math.min(n - 1, s.i1 + EASE);
      const lvl = Math.min(...line.slice(a, b + 1));
      for (let i = a; i <= b; i++) {
        const t = Math.min(1, Math.max(0, i < s.i0 ? (i - a) / (s.i0 - a) : i > s.i1 ? (b - i) / (b - s.i1) : 1)), w = t * t * (3 - 2 * t);
        // (between two stations close together the eases overlap: the lower one counts)
        rail[i] = Math.min(rail[i]!, line[i]! + (lvl - line[i]!) * w);
      }
    }
  }

  /** A point of the cross-section: sample position `at` (may be fractional), u metres left, y above the rail top. */
  const P = (at: number, u: number, y: number): V3 => {
    const i = Math.min(n - 2, Math.max(0, Math.floor(at))), t = at - i;
    const a = mid[i]!, b = mid[i + 1]!, na = normal[i]!, nb = normal[i + 1]!;
    return [
      a.x + (b.x - a.x) * t + (na.x + (nb.x - na.x) * t) * u,
      rail[i]! + (rail[i + 1]! - rail[i]!) * t + y,
      a.z + (b.z - a.z) * t + (na.z + (nb.z - na.z) * t) * u,
    ];
  };
  const xz = (v: V3): Pt => ({ x: v[0], z: v[2] });
  const surface = (p: Pt): number => heightAt(terrain, p.x, p.z) + (env.pavement(p) ? PAVEMENT_H : 0);

  // stairs: from the outer strip of a side platform (the middle of an island) up to the street, near a platform end
  for (const s of stations) {
    const strips: [number, number][] = [];
    const wMid = half[Math.round((s.i0 + s.i1) / 2)]!;
    if (s.island) {
      if (wMid - EDGE >= STAIR_W / 2 + 1.4) strips.push([-STAIR_W / 2, STAIR_W / 2]);
    } else {
      strips.push([wMid + EDGE + PLATFORM_W - STAIR_W, wMid + EDGE + PLATFORM_W], [-(wMid + EDGE + PLATFORM_W), -(wMid + EDGE + PLATFORM_W) + STAIR_W]);
    }
    strips.forEach(([u0, u1], k) => {
      const candidates: (Stair & { score: number })[] = [];
      // a side platform gets one stair (its two candidates: either end), an island one at each end
      for (const end of [0, 1]) {
        const dir = end === 0 ? -1 : 1, edge = end === 0 ? s.i0 : s.i1;
        const um = (u0 + u1) / 2;
        // the width of the box changes right at the platform end: stay a sample clear of it
        let top = edge - dir * 2;
        const groundY = surface(xz(P(top, um, 0)));
        const rise = groundY - (rail[top]! + PLATFORM_H);
        const run = Math.ceil(rise / STAIR_SLOPE / STEP);
        const bottom = top - dir * run;
        if (rise < 2 || bottom < s.i0 + 2 || bottom > s.i1 - 2) continue;
        const stair: Stair = { u0, u1, bottom, top, topY: groundY };
        // not under a building (the whole opening and the first steps out of it), preferably on pavement
        const probes: Pt[] = [];
        for (let j = 0; j <= run; j++) for (const u of [u0, um, u1]) probes.push(xz(P(bottom + dir * j, u, 0)));
        const out = xz(P(top + dir * 1, um, 0));
        probes.push(out);
        if (probes.some((p) => env.built(p))) continue;
        const score = (env.pavement(out) ? 2 : 0) + (env.roadway(out) ? -2 : 0) + (probes.filter((p) => env.roadway(p)).length > probes.length / 2 ? -1 : 0)
          + (end === k % 2 ? 0.5 : 0);
        candidates.push({ ...stair, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of s.island ? candidates : candidates.slice(0, 1)) s.stairs.push({ u0: c.u0, u1: c.u1, bottom: c.bottom, top: c.top, topY: c.topY });
    });
    if (s.stairs.length === 0) console.warn(`transit: ${s.name} has no way up (every stair would end under a building)`);
  }

  // ---- geometry ----
  const inside = new ColorMesh(), outside = new ColorMesh();
  const col: number[] = [];
  const solid = (a: V3, b: V3, c: V3, d: V3) => col.push(...a, ...b, ...c, ...a, ...c, ...d);

  /** Light at sample i: platforms are bright; the tunnel between them is dark but for the glow from a station nearby. */
  const light = (i: number): number => {
    let st = 0;
    for (const s of stations) st = Math.max(st, 1 - Math.max(0, s.i0 - i, i - s.i1) / 14);
    return Math.max(0.035, st * st);
  };
  const stairsOver = (i: number): Stair[] => {
    const s = stationAt(i) ?? stationAt(i + 1);
    return s ? s.stairs.filter((t) => Math.min(t.bottom, t.top) <= i && i + 1 <= Math.max(t.bottom, t.top)) : [];
  };

  /** A box between sample positions s0..s1, across u0..u1 and heights y0..y1; `hard`: also in the collision. */
  const boxAt = (mesh: ColorMesh, s0: number, s1: number, u0: number, u1: number, y0: number, y1: number, color: RGB, lit: number, hard = false): void => {
    const [ua, ub] = [Math.min(u0, u1), Math.max(u0, u1)];
    const ring = (y: number): V3[] => [P(s0, ua, y), P(s1, ua, y), P(s1, ub, y), P(s0, ub, y)];
    const c = [...ring(y0), ...ring(y1)];
    mesh.box(c, color, lit);
    if (hard) for (let q = 0; q < 4; q++) solid(c[q]!, c[(q + 1) % 4]!, c[4 + ((q + 1) % 4)]!, c[4 + q]!);
  };
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1, wi = width(i), wj = width(j), li = light(i), lj = light(j), L: [number, number, number, number] = [li, lj, lj, li];
    const k = (f: number): [number, number, number, number] => [li * f, lj * f, lj * f, li * f];
    const sa = stationAt(i), sb = stationAt(j), st = sa && sb ? sa : undefined;
    const tiles = (sa ?? sb)?.tones;
    // slab, walls (tiled up to 2.6 m above the platform in a station), ceiling
    const fl: [V3, V3, V3, V3] = [P(i, -wi, FLOOR), P(j, -wj, FLOOR), P(j, wj, FLOOR), P(i, wi, FLOOR)];
    inside.quad(...fl, COLORS.slab, L);
    solid(...fl);
    for (const side of [1, -1]) {
      if (tiles) {
        // upright tiles a hand wide, each column in a few pieces of different tones
        const cols = Math.round(STEP / TILE_W);
        for (let c = 0; c < cols; c++) {
          const f0 = c / cols, f1 = (c + 1) / cols, w0 = side * (wi + (wj - wi) * f0), w1 = side * (wi + (wj - wi) * f1);
          const l0 = li + (lj - li) * f0, l1 = li + (lj - li) * f1;
          let y = FLOOR;
          for (let piece = 0; y < CEIL - 1e-6; piece++) {
            const y1 = Math.min(CEIL, y + 0.35 + 1.5 * hash(i * 16 + c, piece, side));
            const col = tiles[Math.floor(hash(i * 16 + c, piece, side + 7) * tiles.length)]!;
            inside.quad(P(i + f0, w0, y), P(i + f1, w1, y), P(i + f1, w1, y1), P(i + f0, w0, y1), col, [l0, l1, l1, l0]);
            y = y1;
          }
        }
      } else {
        inside.quad(P(i, side * wi, FLOOR), P(j, side * wj, FLOOR), P(j, side * wj, CEIL), P(i, side * wi, CEIL), COLORS.wall, k(0.8));
      }
      solid(P(i, side * wi, FLOOR), P(j, side * wj, FLOOR), P(j, side * wj, CEIL), P(i, side * wi, CEIL));
    }
    // the ceiling, left open over the stairs
    const gaps = stairsOver(i).map((t) => [t.u0, t.u1] as [number, number]).sort((a, b) => a[0] - b[0]);
    let from: number | null = null;
    for (const [g0, g1] of [...gaps, [Infinity, Infinity] as [number, number]]) {
      const a = from === null ? [-wi, -wj] : [from, from], b = Number.isFinite(g0) ? [g0, g0] : [wi, wj];
      const q: [V3, V3, V3, V3] = [P(i, a[0]!, CEIL), P(j, a[1]!, CEIL), P(j, b[1]!, CEIL), P(i, b[0]!, CEIL)];
      inside.quad(...q, st ? COLORS.panel : COLORS.ceiling, k(st ? 0.9 : 0.7));
      solid(...q);
      // (the joints of the ceiling panels)
      if (st) inside.quad(P(i, a[0]!, CEIL - 0.004), P(i + 0.02, a[0]!, CEIL - 0.004), P(i + 0.02, b[0]!, CEIL - 0.004), P(i, b[0]!, CEIL - 0.004), COLORS.joint, li * 0.9);
      from = g1;
    }
    // rails
    for (const t of [1, -1]) {
      for (const r of [1, -1]) {
        const ui = t * half[i]! + (r * GAUGE) / 2, uj = t * half[j]! + (r * GAUGE) / 2, w = RAIL_W / 2;
        inside.quad(P(i, ui - w, 0), P(j, uj - w, 0), P(j, uj + w, 0), P(i, ui + w, 0), COLORS.rail, L);
        inside.quad(P(i, ui - w, FLOOR), P(j, uj - w, FLOOR), P(j, uj - w, 0), P(i, ui - w, 0), COLORS.rail, k(0.5));
        inside.quad(P(i, ui + w, FLOOR), P(j, uj + w, FLOOR), P(j, uj + w, 0), P(i, ui + w, 0), COLORS.rail, k(0.5));
      }
    }
    // light bands over the platform edges
    if (st) {
      // (an island never narrower than a strip, should the tracks come together under it)
      const hi = st.island ? Math.max(half[i]!, EDGE + 0.4) : half[i]!, hj = st.island ? Math.max(half[j]!, EDGE + 0.4) : half[j]!;
      // platforms: [inner edge, outer edge] in u, per sample
      const slabs: [[number, number], [number, number]][] = st.island
        ? [[[-(hi - EDGE), hi - EDGE], [-(hj - EDGE), hj - EDGE]]]
        : [[[hi + EDGE, wi], [hj + EDGE, wj]], [[-wi, -(hi + EDGE)], [-wj, -(hj + EDGE)]]];
      for (const [[a0, a1], [b0, b1]] of slabs) {
        const top: [V3, V3, V3, V3] = [P(i, a0, PLATFORM_H), P(j, b0, PLATFORM_H), P(j, b1, PLATFORM_H), P(i, a1, PLATFORM_H)];
        solid(...top);
        // paving slabs about a metre square, each a slightly different grey
        const across = Math.max(1, Math.round(Math.abs(a1 - a0)));
        for (let m = 0; m < 2; m++) {
          for (let c = 0; c < across; c++) {
            const f0 = m / 2, f1 = (m + 1) / 2, g0 = c / across, g1 = (c + 1) / across;
            const u = (f: number, g: number) => a0 + (b0 - a0) * f + (a1 + (b1 - a1) * f - (a0 + (b0 - a0) * f)) * g;
            const shade = 0.93 + 0.07 * hash(i * 2 + m, c, Math.round(a0 * 10));
            const l0 = (li + (lj - li) * f0) * shade, l1 = (li + (lj - li) * f1) * shade;
            inside.quad(P(i + f0, u(f0, g0), PLATFORM_H), P(i + f1, u(f1, g0), PLATFORM_H), P(i + f1, u(f1, g1), PLATFORM_H), P(i + f0, u(f0, g1), PLATFORM_H), COLORS.platform, [l0, l1, l1, l0]);
          }
        }
        // one long strip light over the platform
        {
          const m0 = (a0 + a1) / 2, m1 = (b0 + b1) / 2;
          inside.quad(P(i, m0 - 0.1, CEIL - 0.05), P(j, m1 - 0.1, CEIL - 0.05), P(j, m1 + 0.1, CEIL - 0.05), P(i, m0 + 0.1, CEIL - 0.05), COLORS.light, 1);
          inside.quad(P(i, m0 - 0.14, CEIL - 0.01), P(j, m1 - 0.14, CEIL - 0.01), P(j, m1 - 0.1, CEIL - 0.05), P(i, m0 - 0.1, CEIL - 0.05), COLORS.joint, L);
          inside.quad(P(i, m0 + 0.14, CEIL - 0.01), P(j, m1 + 0.14, CEIL - 0.01), P(j, m1 + 0.1, CEIL - 0.05), P(i, m0 + 0.1, CEIL - 0.05), COLORS.joint, L);
        }
        // the faces towards the tracks, a white line along each edge and a light band above it
        for (const [ea, eb, inward] of [[a0, b0, 1], [a1, b1, -1]] as const) {
          const atWall = Math.abs(Math.abs(ea) - wi) < 1e-6;
          if (atWall) continue;
          const face: [V3, V3, V3, V3] = [P(i, ea, FLOOR), P(j, eb, FLOOR), P(j, eb, PLATFORM_H), P(i, ea, PLATFORM_H)];
          inside.quad(...face, COLORS.face, k(0.7));
          solid(...face);
          inside.quad(P(i, ea + inward * 0.35, PLATFORM_H + 0.005), P(j, eb + inward * 0.35, PLATFORM_H + 0.005), P(j, eb + inward * 0.65, PLATFORM_H + 0.005), P(i, ea + inward * 0.65, PLATFORM_H + 0.005), COLORS.edge, L);
        }
      }
      // between the tracks of a station with side platforms: a row of square columns with a fence from one to the next
      const room = Math.min(half[i]!, half[j]!) - 1.325 - 0.14;
      if (!st.island && room >= 0.1) {
        const c = Math.min(0.2, room), fenceTop = FLOOR + 1.15;
        boxAt(inside, i - c / STEP, i + c / STEP, -c, c, FLOOR, CEIL, COLORS.column, li, true);
        if (st.accent) boxAt(inside, i - (c + 0.004) / STEP, i + (c + 0.004) / STEP, -c - 0.004, c + 0.004, 1.3, 2.9, st.accent, li);
        const f: [V3, V3, V3, V3] = [P(i, 0, FLOOR), P(j, 0, FLOOR), P(j, 0, fenceTop), P(i, 0, fenceTop)];
        inside.quad(...f, COLORS.fence, k(0.8));
        solid(...f);
        for (let bar = 1; bar < 10; bar++) {
          const at = i + bar / 10;
          inside.quad(P(at - 0.008, 0.012, FLOOR + 0.1), P(at + 0.008, 0.012, FLOOR + 0.1), P(at + 0.008, 0.012, fenceTop - 0.06), P(at - 0.008, 0.012, fenceTop - 0.06), COLORS.joint, li * 0.8);
          inside.quad(P(at - 0.008, -0.012, FLOOR + 0.1), P(at + 0.008, -0.012, FLOOR + 0.1), P(at + 0.008, -0.012, fenceTop - 0.06), P(at - 0.008, -0.012, fenceTop - 0.06), COLORS.joint, li * 0.8);
        }
      }
      // on the wall behind a side platform: benches and litter bins, clear of the stairs
      if (!st.island && (i - st.i0) % 6 === 3) {
        for (const side of [1, -1]) {
          if (st.stairs.some((t) => Math.sign(t.u0 + t.u1) === side && i >= Math.min(t.bottom, t.top) - 2 && i <= Math.max(t.bottom, t.top) + 2)) continue;
          const w = side * wi, y = PLATFORM_H;
          boxAt(inside, i, i + 0.8, w - side * 0.5, w - side * 0.04, y + 0.4, y + 0.46, COLORS.bench, li);
          boxAt(inside, i, i + 0.8, w - side * 0.08, w - side * 0.03, y + 0.46, y + 0.85, COLORS.bench, li);
          boxAt(inside, i + 0.1, i + 0.14, w - side * 0.45, w - side * 0.04, y, y + 0.4, COLORS.joint, li);
          boxAt(inside, i + 0.66, i + 0.7, w - side * 0.45, w - side * 0.04, y, y + 0.4, COLORS.joint, li);
          boxAt(inside, i + 1.05, i + 1.22, w - side * 0.28, w - side * 0.03, y + 0.45, y + 1.05, COLORS.bin, li);
          boxAt(inside, i + 1.045, i + 1.225, w - side * 0.285, w - side * 0.03, y + 0.82, y + 0.92, COLORS.bench, li);
        }
      }
    }
    // platform ends: the slab's end face
    for (const [here, there, at] of [[sa, sb, i], [sb, sa, j]] as const) {
      if (!here || there) continue;
      const h = half[at]!, w = width(at);
      const spans: [number, number][] = here.island ? [[-(h - EDGE), h - EDGE]] : [[h + EDGE, w], [-w, -(h + EDGE)]];
      for (const [u0, u1] of spans) {
        const q: [V3, V3, V3, V3] = [P(at, u0, FLOOR), P(at, u1, FLOOR), P(at, u1, PLATFORM_H), P(at, u0, PLATFORM_H)];
        inside.quad(...q, COLORS.face, light(at) * 0.6);
        solid(...q);
      }
    }
  }
  // the ends of the tunnel
  for (const at of [0, n - 1]) {
    const w = width(at);
    const q: [V3, V3, V3, V3] = [P(at, -w, FLOOR), P(at, w, FLOOR), P(at, w, CEIL), P(at, -w, CEIL)];
    inside.quad(...q, COLORS.wall, 0.15);
    solid(...q);
  }

  // stairs and their shafts
  const openings: Pt[][] = [];
  const railAt = (at: number): number => {
    const i = Math.min(n - 2, Math.max(0, Math.floor(at)));
    return rail[i]! + (rail[i + 1]! - rail[i]!) * (at - i);
  };
  for (const s of stations) {
    for (const t of s.stairs) openings.push(buildStair({ P, rail: railAt, surface, inside, outside, solid, tone: s.tones[1]! }, t));
  }

  // tracks: east (northbound) to the right of the centre line, west (southbound) to the left and the other way round
  const trackPts = (side: 1 | -1): number[] => {
    const out: number[] = [];
    const order = side === -1 ? mid.map((_, i) => i) : mid.map((_, i) => n - 1 - i);
    for (const i of order) out.push(...P(i, side * half[i]!, 0).map((v) => Math.round(v * 1000) / 1000));
    return out;
  };
  const tracks = ([-1, 1] as const).map((side) => {
    const pts = trackPts(side);
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i * 3]! - pts[i * 3 - 3]!, pts[i * 3 + 1]! - pts[i * 3 - 2]!, pts[i * 3 + 2]! - pts[i * 3 - 1]!));
    const at = (i: number) => cum[side === -1 ? i : n - 1 - i]!;
    const stops = stations.map((s, k) => ({ station: k, s: Math.round(((at(s.i0) + at(s.i1)) / 2) * 100) / 100, side: (s.island ? 1 : -1) as 1 | -1 }));
    return { pts, stops: stops.sort((a, b) => a.s - b.s) };
  });

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const transit: Transit = {
    headway: HEADWAY,
    stations: stations.map((s) => {
      const c = Math.round((s.i0 + s.i1) / 2), p = P(c, s.island ? 0 : half[c]! + EDGE + 1.5, PLATFORM_H);
      return { name: s.name, x: r2(p[0]), y: r2(p[1]), z: r2(p[2]) };
    }),
    tracks,
    openings: openings.map((ring) => ring.flatMap((p) => [r2(p.x), r2(p.z)])),
  };
  for (const s of stations) {
    console.log(`transit: ${s.name}: ${(s.i1 - s.i0) * STEP} m ${s.island ? 'island' : 'side'} platform${s.island ? '' : 's'}, rail ${(rail[s.i0]! + terrain.datum).toFixed(1)} m NHN, ${s.stairs.length} stair(s)`
      + s.stairs.map((t) => { const p = P(t.top, (t.u0 + t.u1) / 2, 0); return ` → (${p[0].toFixed(1)}, ${p[2].toFixed(1)})`; }).join(''));
  }
  return { transit, models: await encodeModels(inside, outside), collision: Float32Array.from(col), openings };
}

/** One GLB per chunk: the inside (unlit, light baked into the vertex colours) and the parts above ground (lit). */
export async function encodeModels(inside: ColorMesh, outside: ColorMesh): Promise<Map<string, Uint8Array>> {
  await MeshoptEncoder.ready;
  const parts = new Map<string, { in: { pos: number[]; col: number[] }; out: { pos: number[]; col: number[]; nor: number[] } }>();
  const part = (key: string) => {
    let p = parts.get(key);
    if (!p) parts.set(key, (p = { in: { pos: [], col: [] }, out: { pos: [], col: [], nor: [] } }));
    return p;
  };
  for (const [mesh, lit] of [[inside, false], [outside, true]] as const) {
    for (let t = 0; t < mesh.pos.length; t += 9) {
      const p = mesh.pos, cx = (p[t]! + p[t + 3]! + p[t + 6]!) / 3, cz = (p[t + 2]! + p[t + 5]! + p[t + 8]!) / 3;
      const dst = part(chunkKey(cx, cz))[lit ? 'out' : 'in'];
      dst.pos.push(...p.slice(t, t + 9));
      dst.col.push(...mesh.col.slice(t, t + 9));
      if (lit) {
        const ux = p[t + 3]! - p[t]!, uy = p[t + 4]! - p[t + 1]!, uz = p[t + 5]! - p[t + 2]!;
        const vx = p[t + 6]! - p[t]!, vy = p[t + 7]! - p[t + 1]!, vz = p[t + 8]! - p[t + 2]!;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
        for (let k = 0; k < 3; k++) (dst as { nor: number[] }).nor.push(nx / l, ny / l, nz / l);
      }
    }
  }
  const out = new Map<string, Uint8Array>();
  for (const [key, p] of parts) {
    const doc = new Document();
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    const buffer = doc.createBuffer();
    const scene = doc.createScene(`transit_${key}`);
    const acc = (a: number[]) => doc.createAccessor().setType('VEC3').setArray(Float32Array.from(a) as TypedArray).setBuffer(buffer);
    if (p.in.pos.length) {
      const mat = doc.createMaterial('transit_inside').setDoubleSided(true).setBaseColorFactor([1, 1, 1, 1]).setExtension('KHR_materials_unlit', doc.createExtension(KHRMaterialsUnlit).createUnlit());
      const prim = doc.createPrimitive().setAttribute('POSITION', acc(p.in.pos)).setAttribute('COLOR_0', acc(p.in.col)).setMaterial(mat);
      scene.addChild(doc.createNode('transit_inside').setMesh(doc.createMesh('transit_inside').addPrimitive(prim)));
    }
    if (p.out.pos.length) {
      const mat = doc.createMaterial('transit_outside').setDoubleSided(true).setBaseColorFactor([1, 1, 1, 1]).setRoughnessFactor(0.9).setMetallicFactor(0);
      const prim = doc.createPrimitive().setAttribute('POSITION', acc(p.out.pos)).setAttribute('NORMAL', acc(p.out.nor)).setAttribute('COLOR_0', acc(p.out.col)).setMaterial(mat);
      scene.addChild(doc.createNode('transit_outside').setMesh(doc.createMesh('transit_outside').addPrimitive(prim)));
    }
    const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMaterialsUnlit]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    out.set(key, await io.writeBinary(doc));
  }
  return out;
}

export { CHUNK_SIZE };

function fail(msg: string): never {
  throw new Error(msg);
}
