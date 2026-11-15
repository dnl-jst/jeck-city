import { FLAG_NEUSSER, type BuildingMesh } from './buildings.js';
import { footprintContains, footprintDistance } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { cumulative, dedupe, DRIVABLE, dist, distToPolyline, junctions, pointAt } from './polyline.js';
import { edgeAt, inRamp, nearestOn, onCarriageway, profileOf } from './roadprofile.js';
import { buildingGrid, sidewalkWidths } from './sidewalkwidth.js';

/** Mean distance between street trees along a sidewalk (m), and the seeded jitter of each gap (±). */
export const TREE_SPACING = 14;
export const TREE_JITTER = 2;
/** Trunk this far behind the kerb, on the sidewalk (m). */
export const TREE_KERB_OFFSET = 1.2;
/** Only sidewalks at least this wide get trees (m). */
export const TREE_MIN_SIDEWALK = 3.5;
const OSM_TREE_CLEARANCE = 8;
/** Trunk at least this far from a shopfront building (flag bit 0), so the shop entrances stay free. */
const SHOPFRONT_CLEARANCE = 2.5;
/** Trunk at least this far from the kerb of a crossing carriageway (junction corners and mouths). */
const JUNCTION_CLEARANCE = 8;
const STOP_CLEARANCE = 15;
const SPAWN_CLEARANCE = 4;
const TRACK_CLEARANCE = 2.5;
/** Not right next to a lamp post (lamps stand 0.5 m behind the kerb). */
const LAMP_CLEARANCE = 2;
/** Two generated trees closer than this (ways meeting end to end, parallel carriageways): keep the first. */
const GENERATED_CLEARANCE = TREE_SPACING / 2;
const COS30 = Math.cos((30 * Math.PI) / 180);

/** Deterministic [0, 1) value of seed, road id, side and index (murmur3 finalizer). */
function rand(seed: number, id: number, side: number, k: number): number {
  let h = (seed ^ Math.imul(id, 0x9e3779b1) ^ Math.imul(side + 2, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Linear value of per-vertex `v` at arc length s. */
function atS(v: number[], cum: number[], s: number): number {
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < s) i++;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1)));
  return v[i - 1]! + (v[i]! - v[i - 1]!) * t;
}

/**
 * Street trees generated along drivable roads on each side whose sidewalk (sidewalkWidths, as the street meshes
 * use them) is ≥ 3.5 m wide: every 14 ± 2 m (seeded per road and side), 1.2 m behind that side's kerb (road profile;
 * none in a kerb ramp). A candidate is skipped near an OSM tree (8 m), within 2.5 m of a shopfront building (bit 0),
 * within 8 m of a crossing carriageway's kerb (junctions), near a tram stop (15 m), a tram track (2.5 m), a lamp
 * (2 m), the spawn (4 m), another generated tree (7 m), on a carriageway or inside a building footprint.
 * Deterministic: depends on the seed and the input order. OSM trees are not included.
 */
export function streetTrees(f: OsmFeatures, buildings: BuildingMesh[], spawn: Pt, seed: number, lamps: Pt[] = f.lamps): Pt[] {
  const net = f.roads.filter((r) => (DRIVABLE.has(r.kind) || r.kind === 'service') && dedupe(r.points).length >= 2).map((r) => {
    const pts = dedupe(r.points);
    const p = profileOf(r);
    const pad = Math.max(...p.left.map((e) => e.kerb), ...p.right.map((e) => e.kerb)) + JUNCTION_CLEARANCE;
    return { r, box: { minX: Math.min(...pts.map((q) => q.x)) - pad, maxX: Math.max(...pts.map((q) => q.x)) + pad, minZ: Math.min(...pts.map((q) => q.z)) - pad, maxZ: Math.max(...pts.map((q) => q.z)) + pad } };
  });
  type Box = (typeof net)[number]['box'];
  const inBox = (q: Pt, b: Box) => q.x >= b.minX && q.x <= b.maxX && q.z >= b.minZ && q.z <= b.maxZ;
  const juncKeys = new Set(junctions(net.map((n) => dedupe(n.r.points))).keys());
  const grid = buildingGrid(buildings);
  const out: Pt[] = [];

  /** Within `reach` of the kerb of a carriageway that crosses the direction `dir` at pos (not the road itself). */
  const nearCrossing = (pos: Pt, dir: Pt, self: Road) => net.some(({ r: o, box }) => {
    if (o === self || !inBox(pos, box)) return false;
    const n = nearestOn(o, pos);
    if (Math.abs(n.dir.x * dir.x + n.dir.z * dir.z) >= COS30) return false; // parallel: a continuation or a neighbour
    return onCarriageway(o, pos, JUNCTION_CLEARANCE);
  });

  for (const { r } of net) {
    if (!DRIVABLE.has(r.kind)) continue;
    const pts = dedupe(r.points);
    const cum = cumulative(pts);
    const total = cum[cum.length - 1]!;
    const widths = sidewalkWidths(r, buildings, { grid, junctions: juncKeys });
    for (const side of [1, -1] as const) {
      const w = side > 0 ? widths.right : widths.left;
      let k = 0;
      for (let s = TREE_SPACING / 2 + (rand(seed, r.id, side, k) - 0.5) * 2 * TREE_JITTER; s <= total; k++, s += TREE_SPACING + (rand(seed, r.id, side, k) - 0.5) * 2 * TREE_JITTER) {
        if (s < 0 || atS(w, profileOf(r).cum, s) < TREE_MIN_SIDEWALK) continue;
        if (inRamp(r, s - 1, s + 1)) continue; // the kerb moves there
        const { p, dir } = pointAt(pts, cum, s);
        const off = side * (edgeAt(r, side, 'kerb', s) + TREE_KERB_OFFSET);
        const pos = { x: p.x - dir.z * off, z: p.z + dir.x * off };
        if (dist(pos, spawn) < SPAWN_CLEARANCE) continue;
        if (f.trees.some((t) => dist(t, pos) < OSM_TREE_CLEARANCE)) continue;
        if (out.some((t) => dist(t, pos) < GENERATED_CLEARANCE)) continue;
        if (f.tramStops.some((t) => dist(t.pos, pos) < STOP_CLEARANCE)) continue;
        if (lamps.some((l) => dist(l, pos) < LAMP_CLEARANCE)) continue;
        if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) continue;
        const near = grid.near(pos, SHOPFRONT_CLEARANCE);
        if (near.some((b) => footprintContains(b, pos.x, pos.z))) continue;
        if (near.some((b) => (b.flags & FLAG_NEUSSER) !== 0 && footprintDistance(b, pos.x, pos.z) < SHOPFRONT_CLEARANCE)) continue;
        if (net.some(({ r: o, box }) => o !== r && inBox(pos, box) && onCarriageway(o, pos))) continue;
        if (nearCrossing(pos, dir, r)) continue;
        out.push(pos);
      }
    }
  }
  return out;
}
