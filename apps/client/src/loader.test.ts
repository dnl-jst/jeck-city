import { afterEach, describe, expect, it, test, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, Scene } from 'three';
import type { WorldManifest } from '@nn/shared';
import { FetchError } from './errors';
import { chunksToLoad, chunksToUnload, markSigned, WorldLoader } from './loader';

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

describe('WorldLoader', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Spawn far from the origin; chunk downloads never finish. */
  function stubFetch(manifestStatus = 200): string[] {
    const urls: string[] = [];
    const m = gridManifest();
    m.spawn = { x: 700, y: 0, z: 700, heading: 0 };
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url);
      if (url.endsWith('manifest.json')) return Promise.resolve({ ok: manifestStatus === 200, status: manifestStatus, json: () => Promise.resolve(m) });
      return new Promise(() => {});
    });
    return urls;
  }

  it('starts at the spawn and ignores update() until init has finished', async () => {
    const urls = stubFetch();
    const loader = new WorldLoader(new Scene(), '/world/');
    void loader.init(() => {});
    await new Promise((r) => setTimeout(r, 0));
    loader.update({ x: 0, z: 0 });
    expect(urls[0]).toBe('/world/manifest.json');
    expect(urls.slice(1)).toEqual(['/world/chunk_3_3.glb', expect.stringMatching(/chunk_(2_3|4_3|3_2|3_4)\.glb/)]); // nearest to (700, 700), 2 at a time
  });

  it('loads around an explicit start position', async () => {
    const urls = stubFetch();
    void new WorldLoader(new Scene(), '/world/').init(() => {}, { x: -900, z: -900 });
    await new Promise((r) => setTimeout(r, 0));
    expect(urls.slice(1)).toEqual(['/world/chunk_-5_-5.glb', expect.stringMatching(/chunk_(-4_-5|-5_-4)\.glb/)]);
  });

  it('rejects with FetchError when the manifest request fails', async () => {
    stubFetch(404);
    await expect(new WorldLoader(new Scene(), '/world/').init(() => {})).rejects.toBeInstanceOf(FetchError);
  });
});

test('markSigned sets flag bit 2 on the vertex ranges of signed buildings only', () => {
  const g = new BufferGeometry();
  g.setAttribute('_flags', new BufferAttribute(new Float32Array([1, 1, 0, 0, 3, 2]), 1));
  markSigned(g, [{ id: 'A', firstVertex: 0, vertexCount: 2 }, { id: 'B', firstVertex: 2, vertexCount: 2 }, { id: 'C', firstVertex: 4, vertexCount: 2 }], new Set(['A', 'C']));
  expect(Array.from(g.getAttribute('_flags').array)).toEqual([5, 5, 0, 0, 7, 6]);
  markSigned(g, [{ id: 'A', firstVertex: 0, vertexCount: 2 }], new Set(['A'])); // idempotent
  expect(g.getAttribute('_flags').getX(0)).toBe(5);
});
