import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeTerrain, type TerrainGrid } from '@nn/shared';
import { writeWorldIndex } from '../worldindex.js';
import { compareWorlds } from './compare.js';

let a: string;
let b: string;
beforeEach(async () => {
  a = await mkdtemp(join(tmpdir(), 'compare-a-'));
  b = await mkdtemp(join(tmpdir(), 'compare-b-'));
});
afterEach(async () => {
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
});

/** Writes the same files into both folders, then `changes` into b only, and indexes both. */
async function worlds(files: Record<string, string | Uint8Array>, changes: Record<string, string | Uint8Array | null> = {}): Promise<void> {
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(a, name), data);
    if (!(name in changes)) await writeFile(join(b, name), data);
  }
  for (const [name, data] of Object.entries(changes)) if (data !== null) await writeFile(join(b, name), data);
  await writeWorldIndex(a);
  await writeWorldIndex(b);
}

const grid = (heights: number[]): TerrainGrid => ({ x0: -1, z0: -2, cols: 2, rows: 2, datum: 40, heights: Float32Array.from(heights) });

describe('compareWorlds', () => {
  it('two folders with identical files are the same and share the world hash', async () => {
    await worlds({ 'a.bin': 'a', 'chunk_0_0.glb': 'glb' });
    const r = await compareWorlds(a, b);
    expect(r.same).toBe(true);
    expect(r.diffs).toEqual([]);
    expect(r.worldHashA).toMatch(/^[0-9a-f]{12}$/);
    expect(r.worldHashB).toBe(r.worldHashA);
  });

  it('reports a file present on one side only', async () => {
    await worlds({ 'a.bin': 'a', 'only-a.bin': 'x' }, { 'only-a.bin': null, 'only-b.bin': 'y' });
    const r = await compareWorlds(a, b);
    expect(r.same).toBe(false);
    expect(r.worldHashA).not.toBe(r.worldHashB);
    expect(r.diffs).toEqual([
      { name: 'only-a.bin', kind: 'missing-b' },
      { name: 'only-b.bin', kind: 'missing-a' },
    ]);
  });

  it('reports a changed file as different', async () => {
    await worlds({ 'a.bin': 'a', 'b.bin': 'bb' }, { 'b.bin': 'bc' });
    const r = await compareWorlds(a, b);
    expect(r.same).toBe(false);
    expect(r.diffs.map((d) => [d.name, d.kind])).toEqual([['b.bin', 'different']]);
  });

  it('explains a terrain.bin difference: one height 3 cm off → "1 heights differ, max 3 cm"', async () => {
    const ta = new Uint8Array(encodeTerrain(grid([1, 2, 3, 4])));
    const tb = new Uint8Array(encodeTerrain(grid([1, 2, 3.03, 4])));
    await worlds({ 'terrain.bin': ta }, { 'terrain.bin': tb });
    const r = await compareWorlds(a, b);
    expect(r.diffs).toEqual([{ name: 'terrain.bin', kind: 'different', detail: '1 heights differ, max 3 cm' }]);
  });

  it('explains a manifest.json difference by top-level key', async () => {
    const m = { chunks: [{ key: '0_0' }], lamps: [{ x: 1, z: 2 }], shops: [] };
    await worlds({ 'manifest.json': JSON.stringify(m) }, { 'manifest.json': JSON.stringify({ ...m, lamps: [{ x: 1, z: 3 }] }) });
    const r = await compareWorlds(a, b);
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]!.kind).toBe('different');
    expect(r.diffs[0]!.detail).toContain('lamps');
    expect(r.diffs[0]!.detail).not.toContain('chunks');
    expect(r.diffs[0]!.detail).not.toContain('shops');
  });
});
