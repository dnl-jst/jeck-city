import type { BuildingRecord } from './buildingstore.js';
import { footprintContains } from './footprint.js';
import type { OsmFeatures, Pt } from './osm.js';
import { cumulative, dedupe, DRIVABLE, dist, distToPolyline, junctions, pointAt } from './polyline.js';
import { edgeAt, inRamp, onCarriageway } from './roadprofile.js';

/** Distance between generated lamps along a road (m). */
export const LAMP_SPACING = 28;
/** Two-way roads at least this wide get lamps on alternating sides. */
const ALTERNATE_WIDTH = 9;
/** Lamp sits this far beyond the road edge, on the sidewalk next to the kerb. */
const EDGE_OFFSET = 0.5;
const OSM_LAMP_CLEARANCE = 20;
const JUNCTION_CLEARANCE = 6;
const TRACK_CLEARANCE = 2.5;
/** Two generated lamps closer than this (ways meeting end to end, parallel carriageways): keep the first. */
const GENERATED_CLEARANCE = LAMP_SPACING / 2;

type Box = { minX: number; minZ: number; maxX: number; maxZ: number };
const bbox = (pts: Pt[], pad: number): Box => ({
  minX: Math.min(...pts.map((p) => p.x)) - pad, maxX: Math.max(...pts.map((p) => p.x)) + pad,
  minZ: Math.min(...pts.map((p) => p.z)) - pad, maxZ: Math.max(...pts.map((p) => p.z)) + pad,
});
const inBox = (p: Pt, b: Box) => p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;

/**
 * Street lamps generated along drivable roads where OSM maps none: every LAMP_SPACING m 0.5 m beyond that side's kerb
 * (road profile; none in a kerb ramp),
 * on the right of the way direction, alternating sides on two-way roads ≥ 9 m wide. A candidate is skipped near an
 * OSM lamp (20 m), a junction (6 m), a tram track, on another road's carriageway or inside a building footprint.
 * Deterministic: depends only on the input order. OSM lamps are not included.
 */
export function generatedLamps(f: OsmFeatures, buildings: readonly BuildingRecord[]): Pt[] {
  const roads = f.roads.filter((r) => DRIVABLE.has(r.kind)).map((r) => ({ r, pts: dedupe(r.points) })).filter((x) => x.pts.length >= 2);
  const carriageways = f.roads
    .filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service')
    .map((r) => ({ r, pts: dedupe(r.points) }))
    .filter((c) => c.pts.length >= 2)
    .map((c) => ({ ...c, box: bbox(c.pts, c.r.width) })); // the wider side is at most the whole carriageway
  const junc = [...junctions(f.roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service').map((r) => dedupe(r.points))).values()];
  const tracks = f.tramTracks.map((t) => ({ pts: t, box: bbox(t, TRACK_CLEARANCE) }));
  const out: Pt[] = [];

  for (const { r, pts } of roads) {
    const cum = cumulative(pts);
    const total = cum[cum.length - 1]!;
    const alternate = !r.oneway && r.width >= ALTERNATE_WIDTH;
    let k = 0;
    for (let s = LAMP_SPACING / 2; s <= total; s += LAMP_SPACING, k++) {
      const { p, dir } = pointAt(pts, cum, s);
      const side = alternate && k % 2 === 1 ? -1 : 1;
      if (inRamp(r, s - 1, s + 1)) continue; // the kerb moves there
      const off = side * (edgeAt(r, side, 'kerb', s) + EDGE_OFFSET);
      const pos = { x: p.x - dir.z * off, z: p.z + dir.x * off };
      if (f.lamps.some((l) => dist(l, pos) < OSM_LAMP_CLEARANCE)) continue;
      if (out.some((l) => dist(l, pos) < GENERATED_CLEARANCE)) continue;
      if (junc.some((j) => dist(j, pos) < JUNCTION_CLEARANCE)) continue;
      if (tracks.some((t) => inBox(pos, t.box) && distToPolyline(pos, t.pts) < TRACK_CLEARANCE)) continue;
      if (carriageways.some((c) => inBox(pos, c.box) && onCarriageway(c.r, pos))) continue;
      if (buildings.some((b) => footprintContains(b, pos.x, pos.z))) continue;
      out.push(pos);
    }
  }
  return out;
}
