import type { OsmFeatures, Pt } from './osm.js';
import { dedupe, DRIVABLE, distToPolyline } from './polyline.js';

/** Shelter centre distance from the track centreline (m). */
export const SHELTER_OFFSET = 3.5;

/** Nearest track segment to p: its unit direction (way order) and the foot point. */
function nearestSegment(p: Pt, tracks: Pt[][]): { foot: Pt; dir: Pt } | null {
  let best: { foot: Pt; dir: Pt } | null = null;
  let bestD = Infinity;
  for (const t of tracks) {
    for (let i = 1; i < t.length; i++) {
      const a = t[i - 1]!, b = t[i]!;
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
      if (l < 1e-9) continue;
      const u = Math.min(l, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l));
      const foot = { x: a.x + (dx / l) * u, z: a.z + (dz / l) * u };
      const d = Math.hypot(p.x - foot.x, p.z - foot.z);
      if (d < bestD) [bestD, best] = [d, { foot, dir: { x: dx / l, z: dz / l } }];
    }
  }
  return best;
}

/**
 * Shelter position and heading for a tram stop at `stop`: SHELTER_OFFSET m perpendicular from the nearest track,
 * on the side that is not on a road ribbon (drivable or service), else right of the track direction.
 * heading: track direction (forward = (sin h, cos h)), oriented so the track lies on the shelter's left.
 */
export function placeShelter(stop: Pt, f: OsmFeatures): { x: number; z: number; heading: number } {
  const seg = nearestSegment(stop, f.tramTracks);
  if (!seg) return { x: stop.x, z: stop.z, heading: 0 };
  const roads = f.roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service').map((r) => ({ pts: dedupe(r.points), hw: r.width / 2 }));
  const onRoad = (p: Pt) => roads.some((r) => r.pts.length >= 2 && distToPolyline(p, r.pts) < r.hw);
  const at = (side: number): Pt => ({ x: seg.foot.x - seg.dir.z * side * SHELTER_OFFSET, z: seg.foot.z + seg.dir.x * side * SHELTER_OFFSET });
  const side = onRoad(at(1)) && !onRoad(at(-1)) ? -1 : 1;
  const pos = at(side);
  return { x: pos.x, z: pos.z, heading: Math.atan2(side * seg.dir.x, side * seg.dir.z) };
}
