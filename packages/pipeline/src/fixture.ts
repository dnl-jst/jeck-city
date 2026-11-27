import { readFileSync } from 'node:fs';
import type { BuildingMesh } from './buildings.js';
import { recordOf, type BuildingRecord } from './buildingstore.js';
import { crossSectionFromTags, type CrossSection } from './crosssection.js';
import { parseOsm, type OsmFeatures } from './osm.js';

/** Test helper: parsed osm-small.json. */
export const loadFixture = (): OsmFeatures =>
  parseOsm(JSON.parse(readFileSync(new URL('../fixtures/osm-small.json', import.meta.url), 'utf8')));

/** Test helper: cross-section of a `kind` road with the given carriageway width (as if tagged width=…). */
export const crossOf = (kind: string, width: number): CrossSection => crossSectionFromTags({ width: String(width) }, kind);

/** Test helper: axis-aligned box building (4 walls, flat roof), wall triangles outward, roof up. */
export function boxBuilding(id: string, x0: number, z0: number, x1: number, z1: number, h: number, flags = 0): BuildingMesh {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], kind: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], k: number) => {
    for (const p of [a, b, c, a, c, d]) {
      pos.push(...p);
      nor.push(...n);
      uv.push(k ? p[0]! : Math.hypot(p[0]! - a[0]!, p[2]! - a[2]!), k ? p[2]! : p[1]!);
      kind.push(k);
    }
  };
  quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1], [0, 0, 1], 0); // south
  quad([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0], [0, 0, -1], 0); // north
  quad([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1], [1, 0, 0], 0); // east
  quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0], [-1, 0, 0], 0); // west
  quad([x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0], [0, 1, 0], 1); // roof
  return {
    id,
    centroid: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 },
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    facadeUv: new Float32Array(uv),
    kind: new Uint8Array(kind),
    base: 0,
    buildingSeed: [...id].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7),
    flags,
  };
}

/** Test helper: the light record (as a BuildingStore keeps it) of a boxBuilding. */
export const boxRecord = (...args: Parameters<typeof boxBuilding>): BuildingRecord => recordOf(boxBuilding(...args), 0);
