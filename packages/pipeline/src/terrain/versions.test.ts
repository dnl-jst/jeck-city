import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTerrain, encodeTerrain, type TerrainGrid } from '@nn/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abutmentFills, planBridges } from '../bridges.js';
import { crossSectionFromTags } from '../crosssection.js';
import { densify, type OsmFeatures, type Road } from '../osm.js';
import { centreLine, riverTerrain } from '../riverfixture.test-util.js';
import { applyTerrainCuts, applyTerrainFills } from '../terraincut.dense.test-util.js';
import type { Water } from '../water.js';
import * as dense from '../water.dense.test-util.js';
import { TerrainFile, writeTerrainFile } from './file.js';
import { SparseRaster } from './sparse.js';
import { terrainVersions, type TerrainVersions } from './versions.js';

let dir: string;
const opened: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-versions-'));
});
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});

function fileOf(t: TerrainGrid, name: string): TerrainFile {
  const f = writeTerrainFile(join(dir, name), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols)));
  opened.push(f);
  return f;
}
const bytes = (f: TerrainFile) => readFileSync(f.path);
const encoded = (t: TerrainGrid) => Buffer.from(encodeTerrain(t));
/** encodeTerrain, then decodeTerrain: what the dense pipeline did after every step. */
const requantised = (t: TerrainGrid) => decodeTerrain(encodeTerrain(t));
const keep = (v: TerrainVersions) => opened.push(...new Set([v.t0, v.t1, v.t2, v.t3]));

const road = (id: number, pts: [number, number][], bridge: boolean): Road => {
  const cross = crossSectionFromTags({}, 'residential');
  const r: Road = { id, kind: 'residential', points: densify(pts.map(([x, z]) => ({ x, z })), 8), width: cross.carriageway, oneway: false, lanes: 2, cross };
  if (bridge) r.bridge = true;
  return r;
};
/** A street crossing the river fixture on a bridge from x = 120 to 280 (two free ends: two abutments). */
const features: OsmFeatures = {
  boundary: [], roads: [road(1, [[60, 150], [120, 150]], false), road(2, [[120, 150], [280, 150]], true), road(3, [[280, 150], [340, 150]], false)],
  tramTracks: [], bridgeTracks: [], railBridges: [], rivers: [centreLine], tramStops: [], tunnelTracks: [], tunnelPlatforms: [], platforms: [], greens: [],
  trees: [], lamps: [], shops: [], squares: [], bikeParking: [],
};
/** A cut on the west bank reaching down to the river (the water floods into it: water is found on T1). */
const quad = (x0: number, x1: number, z0: number, z1: number, y: number) => [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
const cut = Float32Array.from(quad(135, 148, 60, 80, 0.2));

/** The dense water as sparse rasters (test only), for planBridges in the dense chain. */
function sparseOf(w: dense.Water, cols: number, rows: number): Water {
  const mask = new SparseRaster(cols, rows, (n) => new Uint8Array(n), 0);
  const level = new SparseRaster(cols, rows, (n) => new Float32Array(n), NaN);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (w.mask[i]) mask.set(c, r, 1);
      if (!Number.isNaN(w.level[i]!)) level.set(c, r, w.level[i]!);
    }
  return { mask, level, meanLevel: w.meanLevel, area: w.mask.reduce((n, v) => n + v, 0) };
}

describe('terrainVersions', () => {
  it('the chain T0 → T1 → T2 → T3 on the river fixture with one cut model and two abutments equals the dense chain at every version (file bytes)', () => {
    const g = riverTerrain();
    // a dip behind the west abutment (the fill ramps over it)
    for (let r = 140; r <= 160; r++) for (let c = 108; c <= 121; c++) g.heights[r * g.cols + c] = 5.2;
    const t0 = fileOf(g, 't0.bin');
    const log: string[] = [];
    const v = terrainVersions({ t0, cuts: [cut], features, dir, log: (l) => log.push(l) });
    keep(v);

    // the dense chain as main.ts ran it (re-quantised after every step)
    let d = requantised(g);
    expect(bytes(v.t0).equals(encoded(d))).toBe(true);
    const cutN = applyTerrainCuts(d, cut);
    expect(cutN).toBeGreaterThan(0);
    expect(bytes(v.t1).equals(encoded(d))).toBe(true);
    d = requantised(d);
    const w = dense.findWater(d, [centreLine]);
    expect(w.mask[70 * d.cols + 140]).toBe(1); // in the cut
    const carved = dense.carveRiverBed(d, w);
    expect(v.carved).toBe(carved);
    expect(bytes(v.t2).equals(encoded(d))).toBe(true);
    d = requantised(d);
    const plan = planBridges(features, fileOf(d, 'dense-t2.bin'), sparseOf(w, d.cols, d.rows));
    expect(plan.ends.length).toBe(2);
    expect(v.bridges).toEqual(plan);
    const filled = applyTerrainFills(d, abutmentFills(plan), w.mask);
    expect(filled).toBeGreaterThan(0);
    expect(bytes(v.t3).equals(encoded(d))).toBe(true);

    expect(v.water.area).toBe(w.mask.reduce((n, x) => n + x, 0));
    expect(Object.is(v.water.meanLevel, w.meanLevel)).toBe(true);
    expect(log).toEqual([`terrain cuts: ${cutN} grid points lowered under 1 model(s)`, `terrain fills: ${filled} grid points raised behind 2 abutments`]);
    expect(new Set([v.t0.path, v.t1.path, v.t2.path, v.t3.path]).size).toBe(4);
  });

  it('two cut models: each lowers on the terrain the earlier one left', () => {
    const g = riverTerrain();
    const second = Float32Array.from([...quad(60, 90, 70, 75, 3), ...quad(70, 75, 60, 90, 1)]);
    const log: string[] = [];
    const v = terrainVersions({ t0: fileOf(g, 't0.bin'), cuts: [Float32Array.from(quad(60, 90, 60, 90, 4)), second], features, dir, log: (l) => log.push(l) });
    keep(v);
    const d = requantised(g);
    const n = applyTerrainCuts(d, Float32Array.from(quad(60, 90, 60, 90, 4))) + applyTerrainCuts(d, second);
    expect(bytes(v.t1).equals(encoded(d))).toBe(true);
    expect(log[0]).toBe(`terrain cuts: ${n} grid points lowered under 2 model(s)`);
  });

  it('without cuts T1 is T0 (same file, no second rounding)', () => {
    const t0 = fileOf(riverTerrain(), 't0.bin');
    const log: string[] = [];
    const v = terrainVersions({ t0, cuts: [], features, dir, log: (l) => log.push(l) });
    keep(v);
    expect(v.t1).toBe(v.t0);
    expect(existsSync(join(dir, 't1.bin'))).toBe(false);
    expect(log.map((l) => l.split(':')[0])).toEqual(['terrain fills']);
    // T2 is found and carved on T0 directly
    const d = requantised(riverTerrain());
    const w = dense.findWater(d, [centreLine]);
    dense.carveRiverBed(d, w);
    expect(bytes(v.t2).equals(encoded(d))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['t0.bin', 't2.bin', 't3.bin']);
  });
});
