import { describe, expect, it } from 'vitest';
import type { WorldIndex } from '@nn/shared';
import { missingIndexHint, missingWorldFiles, staleWorldFiles } from './world-complete';

const entry = { hash: '0'.repeat(32), bytes: 1 };
const index: WorldIndex = {
  version: 1,
  files: { 'manifest.json': entry, 'collision.bin': entry, 'bike_mtb.glb': entry, 'tiles/0_0.glb': entry },
};

describe('missingWorldFiles', () => {
  it('is empty when every file of the index is present', () => {
    expect(missingWorldFiles(index, new Set(['index.json', 'manifest.json', 'collision.bin', 'bike_mtb.glb', 'tiles/0_0.glb']))).toEqual([]);
  });

  it('names the files of the index that are not present', () => {
    expect(missingWorldFiles(index, new Set(['index.json', 'manifest.json', 'collision.bin']))).toEqual(['bike_mtb.glb', 'tiles/0_0.glb']);
  });
});

describe('staleWorldFiles', () => {
  const h = (c: string) => c.repeat(32);
  const idx: WorldIndex = { version: 1, files: { 'manifest.json': { hash: h('a'), bytes: 1 }, 'collision.bin': { hash: h('b'), bytes: 1 } } };

  it('is empty when every hashed file matches the index', () => {
    expect(staleWorldFiles(idx, { 'manifest.json': h('a'), 'collision.bin': h('b') })).toEqual([]);
  });

  it('names a file whose hash differs from the index', () => {
    expect(staleWorldFiles(idx, { 'manifest.json': h('a'), 'collision.bin': h('c') })).toEqual(['collision.bin']);
  });

  it('names a file the index does not list', () => {
    expect(staleWorldFiles(idx, { 'manifest.json': h('a'), 'transit-collision.bin': h('d') })).toEqual(['transit-collision.bin']);
  });
});

describe('missingIndexHint', () => {
  it('names npm run build for the built client world', () => {
    expect(missingIndexHint('/repo/apps/client/dist/world')).toMatch(/npm run build/);
    expect(missingIndexHint('/repo/apps/client/dist/world/')).toMatch(/npm run build/);
  });

  it('names npm run world:index for any other folder', () => {
    expect(missingIndexHint('/repo/apps/client/public/world')).toMatch(/npm run world:index/);
    expect(missingIndexHint('/repo/apps/client/public/world')).not.toMatch(/npm run build/);
  });
});
