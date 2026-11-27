import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeTerrain, encodeTerrain, heightAt as sharedHeightAt, type TerrainGrid } from '@nn/shared';
import { TerrainFile, writeTerrainFile } from './file.js';
import { heightAt, TerrainSampler } from './height.js';
import { randomGrid, rng } from './testgrid.test-util.js';

let dir: string;
const open: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-height-'));
});
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});

function fileOf(t: TerrainGrid, blocks?: number): { file: TerrainFile; ref: TerrainGrid } {
  const file = writeTerrainFile(join(dir, `t${open.length}.bin`), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols)));
  open.push(file);
  const f = blocks === undefined ? file : TerrainFile.open(file.path, { blocks });
  if (f !== file) open.push(f);
  return { file: f, ref: decodeTerrain(encodeTerrain(t)) };
}

/** Random points over the grid and 40 m around it, a quarter of them on cell (and block) borders. */
function points(t: TerrainGrid, n: number, seed: number): [number, number][] {
  const rand = rng(seed);
  const out: [number, number][] = [];
  const coord = (o: number, len: number) => {
    const u = -40 + rand() * (len + 80);
    const k = rand();
    if (k < 0.15) return o + Math.round(u); // on a cell border
    if (k < 0.25) return o + 256 * Math.round(rand() * Math.ceil(len / 256)) + (rand() < 0.5 ? 0 : rand() - 0.5); // at a block border
    return o + u;
  };
  for (let i = 0; i < n; i++) out.push([coord(t.x0, t.cols), coord(t.z0, t.rows)]);
  for (const x of [t.x0, t.x0 + 255, t.x0 + 256, t.x0 + 256.5, t.x0 + t.cols - 1, t.x0 + t.cols - 1.5, -Infinity, Infinity])
    for (const z of [t.z0, t.z0 + 256, t.z0 + 255.999, t.z0 + t.rows - 1, t.z0 - 1e9, 1e9]) out.push([x, z]);
  return out;
}

const same = (a: number, b: number) => Object.is(a, b) || (a === 0 && b === 0);

describe('heightAt', () => {
  it('heightAt(sampler) equals @nn/shared heightAt on the whole grid at 20 000 random points, including outside the grid (clamped)', () => {
    for (const [t, blocks, n = 20000] of [
      [randomGrid(600, 530, 4, -2713, -3301), undefined],
      [randomGrid(600, 530, 10, -300, -200), undefined], // the origin inside
      [randomGrid(300, 270, 5, -1234.25, 567.75), 1, 3000], // a fractional origin; every block change evicts
      [randomGrid(257, 1, 6), 2],
      [randomGrid(1, 3, 7), undefined],
    ] as [TerrainGrid, number | undefined, number?][]) {
      const { file, ref } = fileOf(t, blocks);
      const s = new TerrainSampler(file);
      let bad = 0;
      for (const [x, z] of points(t, n, 11)) if (!same(heightAt(s, x, z), sharedHeightAt(ref, x, z))) bad++;
      expect(bad).toBe(0);
      expect(Number.isNaN(heightAt(s, NaN, t.z0))).toBe(true);
    }
  });

  it('heightAt(sampler with a fast window) uses the same value inside and outside the window', () => {
    const t = randomGrid(600, 530, 8, -260, -270);
    const { file, ref } = fileOf(t);
    const fast = file.windowAt({ minX: t.x0 + 200.3, minZ: t.z0 + 240.1, maxX: t.x0 + 330.8, maxZ: t.z0 + 300 }, 1);
    const s = new TerrainSampler(file, fast);
    let bad = 0, inside = 0;
    for (const [x, z] of points(t, 20000, 12)) {
      if (x >= t.x0 + 200 && x <= t.x0 + 331 && z >= t.z0 + 240 && z <= t.z0 + 300) inside++;
      if (!same(heightAt(s, x, z), sharedHeightAt(ref, x, z))) bad++;
    }
    for (let i = 0; i < 5000; i++) {
      const x = t.x0 + 199 + 134 * (i / 5000), z = t.z0 + 239 + 63 * ((i * 7919) % 5000) / 5000;
      if (!same(heightAt(s, x, z), sharedHeightAt(ref, x, z))) bad++;
    }
    expect(inside).toBeGreaterThan(0);
    expect(bad).toBe(0);
    // a window from this file is exact on its own, inside and outside
    for (const [x, z] of points(t, 5000, 13)) if (!same(heightAt(fast, x, z), sharedHeightAt(ref, x, z))) bad++;
    expect(bad).toBe(0);
    // a window of another file is refused as the fast window
    const other = fileOf(t).file;
    expect(() => new TerrainSampler(other, fast)).toThrow(/window/);
  });

  it('heightAt on a plain TerrainGrid is @nn/shared heightAt', () => {
    const t = decodeTerrain(encodeTerrain(randomGrid(90, 70, 9, -10.5, 3)));
    for (const [x, z] of points(t, 5000, 14)) expect(same(heightAt(t, x, z), sharedHeightAt(t, x, z))).toBe(true);
    // a copy of a window is a plain grid: it clamps to itself, as @nn/shared does
    const { file } = fileOf(t);
    const w = file.window(10, 10, 20, 20);
    const copy: TerrainGrid = { ...w };
    expect(heightAt(copy, t.x0 + 50, t.z0 + 50)).toBe(sharedHeightAt(copy, t.x0 + 50, t.z0 + 50));
  });
});
