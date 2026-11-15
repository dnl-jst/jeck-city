import type { BuildingMesh } from './buildings.js';
import { insideAnyFootprint } from './footprint.js';
import type { Pt, Road } from './osm.js';

const SPAWN_ROAD = 'Neusser Straße';
const SIDEWALK_Y = 0.12;
const KERB_DISTANCE = 1.0; // metres from the kerb onto the sidewalk

/**
 * Nearest point on a road named 'Neusser Straße' to `target`, moved sideways onto the sidewalk, 1.0 m from the kerb
 * (carriageway/2 + 1.0). Sides with a parking strip come first (east before west otherwise); the first one not inside
 * a building wins. heading = atan2(dx, dz) along the road towards north (-z), i.e. forward = (sin h, cos h).
 */
export function findSpawn(roads: Road[], target: Pt, buildings: BuildingMesh[]): { x: number; y: number; z: number; heading: number } {
  let best: { p: Pt; dir: Pt; road: Road; d: number } | undefined;
  for (const r of roads) {
    if (r.name !== SPAWN_ROAD) continue;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!, b = r.points[i]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-12) continue;
      const t = Math.min(1, Math.max(0, ((target.x - a.x) * dx + (target.z - a.z) * dz) / l2));
      const p = { x: a.x + t * dx, z: a.z + t * dz };
      const d = Math.hypot(p.x - target.x, p.z - target.z);
      if (!best || d < best.d) best = { p, dir: { x: dx / Math.sqrt(l2), z: dz / Math.sqrt(l2) }, road: r, d };
    }
  }
  if (!best) throw new Error(`findSpawn: no road named ${SPAWN_ROAD}`);
  const { p: foot, road } = best;
  const toNorth = best.dir.z > 0 ? -1 : 1; // way direction × toNorth points north
  const dir = { x: best.dir.x * toNorth, z: best.dir.z * toNorth };
  const off = road.width / 2 + KERB_DISTANCE;
  // s: side relative to the way (right of travel = (-dir.z, dir.x)); right of north = east comes first on a tie
  const sides = [toNorth, -toNorth]
    .map((s) => ({ park: s > 0 ? road.cross.parkRight : road.cross.parkLeft, q: { x: foot.x - best.dir.z * off * s, z: foot.z + best.dir.x * off * s } }))
    .sort((a, b) => Number(b.park > 0) - Number(a.park > 0))
    .map((c) => c.q);
  const p = sides.find((q) => !insideAnyFootprint(q, buildings)) ?? sides[0]!;
  return { x: p.x, y: SIDEWALK_Y, z: p.z, heading: Math.atan2(dir.x, dir.z) };
}
