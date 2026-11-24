import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWorldIndex, contentHash, writeWorldIndex } from './worldindex.js';

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
});
