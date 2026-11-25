import { parseMapData, type MapData } from '@nn/shared';
import type { BuildingRecord } from './buildingstore.js';
import type { OsmFeatures } from './osm.js';

type Pt = { x: number; z: number };

const r1 = (v: number) => Math.round(v * 10) / 10;
const flatten = (pts: Pt[]) => pts.flatMap((p) => [r1(p.x), r1(p.z)]);

/** Roof triangles of one building (its footprint) as flat xz triangles. */
const roofTriangles = (b: BuildingRecord): number[] => b.footprint.tris.map(r1);

/** Vector map for the client (minimap and big map): coordinates rounded to 0.1 m, validated against the shared schema. */
export function buildMapData(f: OsmFeatures, buildings: readonly BuildingRecord[], water: Pt[][] = []): MapData {
  const boundary = flatten(f.boundary);
  const roads = f.roads.map((r) => ({ kind: r.kind, ...(r.name !== undefined ? { name: r.name } : {}), width: r.width, pts: flatten(r.points) }));
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const pts of [boundary, ...roads.map((r) => r.pts)]) {
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!);
      maxX = Math.max(maxX, pts[i]!);
      minZ = Math.min(minZ, pts[i + 1]!);
      maxZ = Math.max(maxZ, pts[i + 1]!);
    }
  }
  return parseMapData({
    version: 1,
    bounds: { minX, minZ, maxX, maxZ },
    boundary,
    roads,
    buildings: buildings.map(roofTriangles).filter((t) => t.length > 0),
    greens: f.greens.map(flatten),
    water: water.map(flatten),
    squares: f.squares.map((s) => ({ name: s.name, pts: flatten(s.outline) })),
    tram: f.tramTracks.map(flatten),
    tramStops: f.tramStops.map((s) => ({ name: s.name, x: r1(s.pos.x), z: r1(s.pos.z) })),
  });
}
