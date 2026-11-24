import { describe, expect, it } from 'vitest';
import type { WorldIndex } from '@nn/shared';
import { missingWorldFiles } from './world-complete';

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
