import type { BuildingMesh } from './buildings.js';
import { insideAnyFootprint } from './footprint.js';
import type { Pt, Road } from './osm.js';
import { dedupe } from './polyline.js';
import { edgeAt, nearestOn } from './roadprofile.js';

const SPAWN_ROAD = 'Neusser Straße';
const SIDEWALK_Y = 0.12;
const KERB_DISTANCE = 1.0; // metres from the kerb onto the sidewalk

/**
 * Nearest point on a road named 'Neusser Straße' to `target`, moved sideways onto the sidewalk, 1.0 m from the kerb
 * (that side's kerb in the road profile + 1.0). Sides with a parking strip come first (east before west otherwise); the first one not inside
 * a building wins. heading = atan2(dx, dz) along the road towards north (-z), i.e. forward = (sin h, cos h).
 */
export function findSpawn(roads: Road[], target: Pt, buildings: BuildingMesh[]): { x: number; y: number; z: number; heading: number } {
  let best: { road: Road; n: ReturnType<typeof nearestOn> } | undefined;
  for (const r of roads) {
    if (r.name !== SPAWN_ROAD || dedupe(r.points).length < 2) continue;
    const n = nearestOn(r, target);
    if (!best || n.dist < best.n.dist) best = { road: r, n };
  }
  if (!best) throw new Error(`findSpawn: no road named ${SPAWN_ROAD}`);
  const { road, n } = best;
  const foot = { x: target.x + n.dir.z * n.d, z: target.z - n.dir.x * n.d }; // target moved back onto the centre line
  const toNorth = n.dir.z > 0 ? -1 : 1; // way direction × toNorth points north
  const dir = { x: n.dir.x * toNorth, z: n.dir.z * toNorth };
  // s: side relative to the way (right of travel = (-dir.z, dir.x)); right of north = east comes first on a tie
  const sides = [toNorth, -toNorth]
    .map((sd) => {
      const off = edgeAt(road, sd, 'kerb', n.s) + KERB_DISTANCE; // 1 m beyond that side's kerb
      const park = sd > 0 ? road.cross.parkRight : road.cross.parkLeft;
      return { park, q: { x: foot.x - n.dir.z * off * sd, z: foot.z + n.dir.x * off * sd } };
    })
    .sort((a, b) => Number(b.park > 0) - Number(a.park > 0))
    .map((c) => c.q);
  const p = sides.find((q) => !insideAnyFootprint(q, buildings)) ?? sides[0]!;
  return { x: p.x, y: SIDEWALK_Y, z: p.z, heading: Math.atan2(dir.x, dir.z) };
}
