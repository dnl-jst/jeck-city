import { describe, expect, it } from 'vitest';
import type { WorldManifest } from '@nn/shared';
import { chunksToLoad, chunksToUnload } from './loader';

/** Manifest with a grid of chunks ix, iz ∈ [-5, 4] (min corners -1000 … 800). */
function gridManifest(): WorldManifest {
  const chunks: WorldManifest['chunks'] = [];
  for (let ix = -5; ix < 5; ix++)
    for (let iz = -5; iz < 5; iz++)
      chunks.push({ key: `${ix}_${iz}`, x: ix * 200, z: iz * 200, file: `chunk_${ix}_${iz}.glb`, bytes: 1 });
  return {
    version: 1, origin: { e: 0, n: 0 }, chunkSize: 200, chunks,
    spawn: { x: 0, y: 0, z: 0, heading: 0 }, boundary: [], lamps: [], trees: [], tramStops: [],
    shops: [], parked: [], attribution: '',
  };
}
const centreDist = (key: string, px: number, pz: number): number => {
  const [ix, iz] = key.split('_').map(Number) as [number, number];
  return Math.hypot(ix * 200 + 100 - px, iz * 200 + 100 - pz);
};

describe('chunksToLoad', () => {
  it('returns every chunk whose centre is within 600 m of (0,0), nearest first', () => {
    const m = gridManifest();
    const keys = chunksToLoad(m, { x: 0, z: 0 }, new Set());
    const expected = m.chunks.filter((c) => Math.hypot(c.x + 100, c.z + 100) <= 600).map((c) => c.key);
    expect(new Set(keys)).toEqual(new Set(expected));
    expect(keys).toHaveLength(expected.length);
    expect(keys).toContain('2_-1'); // centre (500, -100): 509.9 m
    expect(keys).not.toContain('2_2'); // centre (500, 500): 707 m
    const d = keys.map((k) => centreDist(k, 0, 0));
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(keys.slice(0, 4).sort()).toEqual(['-1_-1', '-1_0', '0_-1', '0_0']);
  });

  it('skips chunks that are already loaded', () => {
    const keys = chunksToLoad(gridManifest(), { x: 0, z: 0 }, new Set(['0_0', '1_1']));
    expect(keys).not.toContain('0_0');
    expect(keys).not.toContain('1_1');
    expect(keys).toContain('-1_-1');
  });
});

describe('chunksToUnload', () => {
  it('returns loaded chunks whose centre is more than 800 m away, keeps the rest', () => {
    const m = gridManifest();
    // '4_0' centre (900, 100) is 905 m away, '3_0' centre (700, 100) 707 m (hysteresis band).
    expect(chunksToUnload(m, { x: 0, z: 0 }, new Set(['0_0', '3_0', '4_0']))).toEqual(['4_0']);
  });
});
