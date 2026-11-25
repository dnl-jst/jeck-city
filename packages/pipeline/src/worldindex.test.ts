import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginWorldWrite, buildWorldIndex, contentHash, writeWorldIndex } from './worldindex.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'worldindex-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('world index', () => {
  it('lists every file except index.json, sorted by name, with size and hash', async () => {
    await writeFile(join(dir, 'b.glb'), 'bb');
    await writeFile(join(dir, 'a.bin'), 'a');
    await writeFile(join(dir, 'index.json'), 'old');
    await writeFile(join(dir, '.DS_Store'), 'x');
    const index = await buildWorldIndex(dir);
    expect(Object.keys(index.files)).toEqual(['a.bin', 'b.glb']);
    expect(index.files['a.bin']).toEqual({ hash: contentHash(Buffer.from('a')), bytes: 1 });
    expect(contentHash(Buffer.from('a'))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('writeWorldIndex is byte-identical for the same content and changes when one file changes at the same size', async () => {
    await writeFile(join(dir, 'b.glb'), 'bb');
    await writeFile(join(dir, 'a.bin'), 'a');
    await writeWorldIndex(dir);
    const first = await readFile(join(dir, 'index.json'));
    await writeWorldIndex(dir);
    expect((await readFile(join(dir, 'index.json'))).equals(first)).toBe(true);
    await writeFile(join(dir, 'b.glb'), 'bc');
    await writeWorldIndex(dir);
    expect((await readFile(join(dir, 'index.json'))).equals(first)).toBe(false);
  });

  it('rejects sub-directories', async () => {
    await mkdir(join(dir, 'sub'));
    await expect(buildWorldIndex(dir)).rejects.toThrow(/flat/);
  });

  it.each(['map.json.br', 'map.json.gz'])('rejects a built dist/world (%s)', async (name) => {
    await writeFile(join(dir, 'map.json'), '{}');
    await writeFile(join(dir, name), 'x');
    await expect(buildWorldIndex(dir)).rejects.toThrow(/dist\/world/);
  });
});

describe('beginWorldWrite', () => {
  it('removes index.json and the GLBs matching the pattern, keeps everything else, and creates a missing folder', async () => {
    for (const f of ['index.json', 'manifest.json', 'terrain.bin', 'chunk_0_0.glb', 'model_dom.glb', 'transit_1_2.glb', 'bike_1.glb']) await writeFile(join(dir, f), 'x');
    await beginWorldWrite(dir, /^(chunk|model|transit)_.*\.glb$/);
    expect((await readdir(dir)).sort()).toEqual(['bike_1.glb', 'manifest.json', 'terrain.bin']);
    // the Stadtbahn alone: its GLBs and the index go, the city's chunks stay
    for (const f of ['index.json', 'chunk_0_0.glb', 'transit_1_2.glb']) await writeFile(join(dir, f), 'x');
    await beginWorldWrite(dir, /^transit_.*\.glb$/);
    expect((await readdir(dir)).sort()).toEqual(['bike_1.glb', 'chunk_0_0.glb', 'manifest.json', 'terrain.bin']);
    // a folder without an index (or not there at all) is fine
    await beginWorldWrite(dir, /^transit_.*\.glb$/);
    await beginWorldWrite(join(dir, 'new', 'world'), /^transit_.*\.glb$/);
    expect(await readdir(join(dir, 'new', 'world'))).toEqual([]);
  });
});
