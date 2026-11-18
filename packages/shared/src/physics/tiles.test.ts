import { describe, expect, test } from 'vitest';
import { compactMesh, createPhysicsWorld, tileTriangles } from './world';

/** A flat square grid of n×n cells (side `cell` m), two triangles each, from (0, 0). */
function grid(n: number, cell: number): { vertices: Float32Array; indices: Uint32Array; boundary: Float32Array } {
  const v: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) v.push(i * cell, 0, j * cell);
  const at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) idx.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
  }
  return { vertices: new Float32Array(v), indices: new Uint32Array(idx), boundary: new Float32Array() };
}

describe('collision tiles', () => {
  test('every triangle lands in exactly one tile, by centroid, in a fixed order', () => {
    const g = grid(8, 25); // 200 m square: 2×2 tiles of 100 m
    const tiles = tileTriangles(g.vertices, g.indices, 100);
    expect(tiles.length).toBe(4);
    expect(tiles.reduce((s, t) => s + t.length, 0)).toBe(g.indices.length);
    const tris = (a: Uint32Array) => Array.from({ length: a.length / 3 }, (_, k) => [...a.subarray(3 * k, 3 * k + 3)].join());
    expect(new Set(tiles.flatMap(tris))).toEqual(new Set(tris(g.indices)));
    expect(tileTriangles(g.vertices, g.indices, 100)).toEqual(tiles);
  });

  test('compactMesh keeps only the used vertices and the same triangles', () => {
    const v = new Float32Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 0, 0, 1]);
    const m = compactMesh(v, new Uint32Array([0, 2, 3]));
    expect([...m.vertices]).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect([...m.indices]).toEqual([0, 1, 2]);
  });

  test('a tiled city is one collider per tile, the same with and without time slicing, and solid everywhere', async () => {
    const g = grid(8, 25);
    const plain = await createPhysicsWorld(g);
    const sliced = await createPhysicsWorld(g, undefined, { sliceMs: 0 });
    expect(plain.world.colliders.len()).toBe(4);
    expect(sliced.world.colliders.len()).toBe(4);
    const R = plain.rapier;
    for (const [x, z] of [[10, 10], [99.9, 100.1], [150, 30], [199, 199]] as const) {
      for (const pw of [plain, sliced]) {
        const hit = pw.world.castRay(new R.Ray({ x, y: 5, z }, { x: 0, y: -1, z: 0 }), 10, true);
        expect(hit?.timeOfImpact).toBeCloseTo(5, 4);
      }
    }
  });
});

describe('streamed city', () => {
  test('only tiles near the stream points exist; they follow the points and match the full build', async () => {
    const g = grid(40, 25); // 1 km square: 10×10 tiles of 100 m
    const full = await createPhysicsWorld(g);
    const pw = await createPhysicsWorld(g, undefined, { stream: [{ x: 50, z: 50 }] });
    const city = pw.city!;
    expect(city.count).toBe(100);
    expect(city.built).toBeGreaterThan(0);
    expect(city.built).toBeLessThan(100);
    const R = pw.rapier;
    const ray = (w: typeof pw, x: number, z: number) => w.world.castRay(new R.Ray({ x, y: 5, z }, { x: 0, y: -1, z: 0 }), 10, true)?.timeOfImpact ?? null;
    expect(ray(pw, 60, 60)).toBeCloseTo(5, 4);
    expect(ray(pw, 950, 950)).toBeNull(); // far corner: not built
    // move to the far corner: needed tiles are built even with no time budget, the start is dropped
    city.update([{ x: 950, z: 950 }], 0);
    pw.world.step();
    expect(ray(pw, 950, 950)).toBeCloseTo(ray(full, 950, 950)!, 6);
    expect(ray(pw, 60, 60)).toBeNull();
    // with time, everything within CITY_WANT comes
    city.update([{ x: 950, z: 950 }], Infinity);
    const near = city.built;
    expect(city.update([{ x: 950, z: 950 }], Infinity)).toBe(0);
    expect(near).toBeGreaterThan(0);
  });
});
