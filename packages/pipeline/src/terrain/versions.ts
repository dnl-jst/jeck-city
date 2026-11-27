import { join } from 'node:path';
import { abutmentFills, type BridgePlan, planBridges } from '../bridges.js';
import type { OsmFeatures } from '../osm.js';
import { noEdits, terrainCutEdits, terrainFillEdits } from '../terraincut.js';
import { carveRiverBed, findWater, type Water } from '../water.js';
import { commitVersion, type TerrainFile } from './file.js';

/**
 * The four terrain versions, each a file in terrain.bin's layout, quantised relative to its own lowest point:
 *   T0 the blurred DGM (buildings stand on it), T1 after the models' cuts (the water is found on it), T2 after the
 *   river bed (the bridges are planned on it), T3 after the fills behind the abutments (everything else, and the
 *   world's terrain.bin).
 * Also the water (found on T1), the bridges (planned on T2) and the number of grid points the river bed lowered.
 */
export type TerrainVersions = { t0: TerrainFile; t1: TerrainFile; t2: TerrainFile; t3: TerrainFile; water: Water; bridges: BridgePlan; carved: number };

/**
 * T1–T3 from T0, written to `dir` as t1.bin, t2.bin and t3.bin (each from the one before by commitVersion: unedited
 * points keep their decoded height, the version is re-quantised with its new minimum).
 *
 * `cuts`: the cut surfaces of the replacement models that have one, in model order. Each model lowers the terrain the
 * earlier ones left; all cuts become one version. Without cuts T1 is T0 itself (no second rounding). T2 and T3 are
 * always written. Logs the "terrain cuts" (only with cuts) and "terrain fills" lines.
 */
export function terrainVersions(o: { t0: TerrainFile; cuts: Float32Array[]; features: OsmFeatures; dir: string; log?: (line: string) => void }): TerrainVersions {
  const { t0 } = o;
  let t1 = t0;
  if (o.cuts.length) {
    const pending = noEdits(t0.cols, t0.rows);
    let n = 0;
    for (const tris of o.cuts) n += terrainCutEdits(t0, pending, tris);
    t1 = commitVersion(t0, pending.edits, pending.edited, join(o.dir, 't1.bin'));
    o.log?.(`terrain cuts: ${n} grid points lowered under ${o.cuts.length} model(s)`);
  }

  // the Rhine: water found on the DGM water surface, the bed carved below it; then the bridges over it
  const water = findWater(t1, o.features.rivers);
  const bed = carveRiverBed(t1, water);
  const t2 = commitVersion(t1, bed.edits, bed.edited, join(o.dir, 't2.bin'));
  const bridges = planBridges(o.features, t2, water);
  // the ground behind the abutments ramps up to the deck (DGM1 dips at quay edges and underpasses)
  const fill = terrainFillEdits(t2, abutmentFills(bridges), water.mask);
  const t3 = commitVersion(t2, fill.edits, fill.edited, join(o.dir, 't3.bin'));
  o.log?.(`terrain fills: ${fill.raised} grid points raised behind ${bridges.ends.length} abutments`);
  return { t0, t1, t2, t3, water, bridges, carved: bed.lowered };
}
