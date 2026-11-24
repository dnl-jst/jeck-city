import { describe, expect, it } from 'vitest';
import type { TerrainGrid } from '@nn/shared';
import { cropMesh, drapeChunk, prepareFlat } from './chunkdrape.js';
import { splitMesh, type Rect } from './chunks.js';
import { drapeMesh } from './drape.js';
import type { Mesh } from './streets.js';

/** Today's rule: crop, drape the whole mesh, split the draped triangles into chunks. */
const reference = (m: Mesh, t: TerrainGrid, area: Rect) => splitMesh(drapeMesh(cropMesh(m, area), t), area);

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1 m grid from (-700.5, -700.5), 2100 × 2100 points: covers every test mesh; not aligned with the chunk lines
const X0 = -700.5;
const N = 2100;
function terrain(seed: number): TerrainGrid {
  const r = rng(seed);
  const [a, b, c, d] = [r() * 0.05, r() * 0.05, 0.2 + r(), 0.2 + r()];
  const heights = new Float32Array(N * N);
  for (let row = 0; row < N; row++)
    for (let col = 0; col < N; col++) heights[row * N + col] = 3 + a * col - b * row + Math.sin(col * c) * Math.cos(row * d);
  return { x0: X0, z0: X0, cols: N, rows: N, datum: 0, heights };
}
const hills = terrain(1);

type V = [number, number, number];
/** Indexed mesh from triangles (each triangle its own three vertices); uv = (x, z) / 10, mark per triangle if given. */
function mesh(tris: V[][], marks?: number[]): Mesh {
  const pos = tris.flat(2);
  const n = pos.length / 3;
  const m: Mesh = {
    positions: Float32Array.from(pos),
    indices: Uint32Array.from({ length: n }, (_, i) => i),
    uv: Float32Array.from(tris.flat().flatMap((p) => [p[0] / 10, p[2] / 10])),
  };
  if (marks) m.mark = Float32Array.from(tris.flatMap((_, i) => [marks[i]!, marks[i]!, marks[i]!]));
  return m;
}

const bytes = (a: Float32Array | Uint32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const meshBytes = (m: Mesh | undefined) =>
  m && { positions: bytes(m.positions), uv: bytes(m.uv), indices: bytes(m.indices), mark: m.mark && bytes(m.mark) };

const AREA: Rect = { minX: -400, minZ: -400, maxX: 1000, maxZ: 1000 };

/** Every chunk the reference or a source's bucket names: drapeChunk equals the reference byte for byte. */
function expectSame(m: Mesh, t: TerrainGrid, area: Rect) {
  const ref = reference(m, t, area);
  const src = prepareFlat(m, area);
  const keys = new Set([...ref.keys(), ...src.trianglesByChunk.keys()]);
  const got = new Map<string, Mesh>();
  for (const key of keys) {
    const [ix, iz] = key.split('_').map(Number) as [number, number];
    const part = drapeChunk(src, t, ix, iz, area);
    expect(meshBytes(part), key).toEqual(meshBytes(ref.get(key)));
    if (part) got.set(key, part);
  }
  expect([...got.keys()].sort()).toEqual([...ref.keys()].sort());
  // every chunk of the reference is among the buckets (the key set can be derived without draping)
  for (const key of ref.keys()) expect(src.trianglesByChunk.has(key), key).toBe(true);
  return { ref, got };
}

// draping hundreds of thousands of 1 m cells: a few seconds alone, more while the whole suite runs in parallel
describe('drapeChunk', { timeout: 60000 }, () => {
  it('equals the reference for every chunk of a ribbon crossing four chunks', () => {
    // a road ribbon from chunk 0_0 to chunk 1_1, two triangles per 10 m segment, sharing vertices
    const pos: number[] = [];
    const idx: number[] = [];
    for (let k = 0; k <= 30; k++) {
      const x = 120 + k * 5, z = 130 + k * 4.3;
      pos.push(x - 2, 0.01, z + 2, x + 2, 0.01, z - 2);
      if (k > 0) idx.push(2 * k - 2, 2 * k, 2 * k - 1, 2 * k - 1, 2 * k, 2 * k + 1);
    }
    const m: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uv: Float32Array.from({ length: (pos.length / 3) * 2 }, (_, i) => i * 0.37) };
    const { ref } = expectSame(m, hills, AREA);
    expect([...ref.keys()].sort()).toEqual(['0_0', '0_1', '1_0', '1_1']);
  });

  it('a triangle 600 m wide lands in exactly the chunks the reference puts it in, nothing twice', () => {
    const m = mesh([[[-150, 0.05, -120], [470, 0.05, 60], [30, 0.05, 330]]]);
    const { ref, got } = expectSame(m, hills, AREA);
    const count = (s: Map<string, Mesh>) => [...s.values()].reduce((n, p) => n + p.indices.length / 3, 0);
    expect(got.size).toBeGreaterThan(4);
    expect(count(got)).toBe(count(ref));
    expect(count(got)).toBe(drapeMesh(cropMesh(m, AREA), hills).indices.length / 3);
  });

  it('vertical kerb faces (zero xz area) match the reference', () => {
    // kerb quads along a line crossing x = 200, z = 200 and z = 400
    const tris: V[][] = [];
    for (let k = 0; k < 12; k++) {
      const [x0, z0, x1, z1] = [190 + k * 3.1, 180 + k * 19.7, 190 + (k + 1) * 3.1, 180 + (k + 1) * 19.7];
      tris.push([[x0, 0, z0], [x1, 0, z1], [x1, 0.12, z1]], [[x0, 0, z0], [x1, 0.12, z1], [x0, 0.12, z0]]);
    }
    const { ref } = expectSame(mesh(tris), hills, AREA);
    expect(ref.size).toBeGreaterThan(2);
  });

  it('marked meshes keep the global first-appearance order of mark values', () => {
    // marks 3, 1, 3, 2: chunk 0_0 sees 3, 1, 3; chunk 1_0 sees only 2 and 3 (its 3 still comes first)
    const m = mesh([
      [[10, 0.02, 10], [12, 0.02, 30], [30, 0.02, 12]],
      [[50, 0.02, 10], [52, 0.02, 30], [70, 0.02, 12]],
      [[190, 0.02, 50], [192, 0.02, 70], [215, 0.02, 52]],
      [[250, 0.02, 10], [252, 0.02, 30], [270, 0.02, 12]],
    ], [3, 1, 3, 2]);
    const src = prepareFlat(m, AREA);
    expect(src.markOrder).toEqual([3, 1, 2]);
    const { got } = expectSame(m, hills, AREA);
    const marks = (key: string) => [...new Set(got.get(key)!.mark!)];
    expect(marks('0_0')).toEqual([3, 1]);
    expect(marks('1_0')).toEqual([3, 2]);
  });

  it('a chunk no draped triangle falls into yields undefined', () => {
    // the bbox reaches into chunk 1_1 (x, z ≥ 200), the triangle does not (x + z ≤ 350)
    const m = mesh([[[100, 0.05, 100], [250, 0.05, 100], [100, 0.05, 250]]]);
    const src = prepareFlat(m, AREA);
    expect(src.trianglesByChunk.has('1_1')).toBe(true);
    expect(drapeChunk(src, hills, 1, 1, AREA)).toBeUndefined();
    expect(drapeChunk(src, hills, 5, 5, AREA)).toBeUndefined(); // a chunk no source triangle touches
    const { ref } = expectSame(m, hills, AREA);
    expect(ref.has('1_1')).toBe(false);
  });

  it('triangles whose centroid lies outside the area are dropped as the reference drops them', () => {
    const area: Rect = { minX: 0, minZ: 0, maxX: 300, maxZ: 300 };
    const m = mesh([
      [[-30, 0.05, 10], [-10, 0.05, 10], [-20, 0.05, 30]], // centroid outside: cropped
      [[-20, 0.05, 50], [40, 0.05, 50], [10, 0.05, 90]], // centroid inside, reaches outside: draped pieces left of x = 0 dropped
      [[280, 0.05, 280], [330, 0.05, 280], [280, 0.05, 330]], // centroid inside (296.7), pieces beyond 300 dropped
    ]);
    const { ref } = expectSame(m, hills, area);
    const xs = [...ref.values()].flatMap((p) => Array.from({ length: p.indices.length / 3 }, (_, t) =>
      [0, 1, 2].reduce((s, k) => s + p.positions[p.indices[t * 3 + k]! * 3]!, 0) / 3));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(300);
  });

  it('property test: 200 random flat meshes on a random terrain match the reference chunk by chunk', () => {
    const r = rng(20261124);
    const t = terrain(7);
    // vertices often sit right at a chunk line (±1 mm), where float32 centroids decide the chunk
    const coord = () => (r() < 0.3 ? 200 * Math.floor(r() * 4) + (r() - 0.5) * 0.002 : -200 + r() * 1000);
    for (let n = 0; n < 200; n++) {
      const tris: V[][] = [];
      const count = 1 + Math.floor(r() * 4);
      for (let k = 0; k < count; k++) {
        const size = 0.2 * 2500 ** r(); // 0.2 m … 500 m
        const [cx, cz] = [coord(), coord()];
        const p = (): V => [cx + (r() - 0.5) * size, r() < 0.5 ? 0.01 : 0.12, cz + (r() - 0.5) * size];
        if (r() < 0.2) {
          // a vertical face: two points of the trace, one lifted
          const [a, b] = [p(), p()];
          tris.push([a, b, [b[0], b[1] + 0.12, b[2]]]);
        } else tris.push([p(), p(), p()]);
      }
      const marked = r() < 0.3;
      const m = mesh(tris, marked ? tris.map(() => Math.floor(r() * 3)) : undefined);
      expectSame(m, t, AREA);
    }
  });
});
