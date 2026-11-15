import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { buildBuildingMesh, isInternalWall, type BuildingMesh } from './buildings.js';
import { parseCityGml } from './citygml.js';
import { utmToLocal, type TerrainGrid } from '@nn/shared';

const read = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8');
const building = () => parseCityGml(read('gable-house.gml'))[0]!;
const mesh = () => buildBuildingMesh(building())!;

const ys = (m: BuildingMesh) => Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[i * 3 + 1]!);
const minY = (m: BuildingMesh) => Math.min(...ys(m));
const maxY = (m: BuildingMesh) => Math.max(...ys(m));

test('gable house sits on y=0 and reaches 13 m', () => {
  const m = mesh();
  expect(minY(m)).toBeCloseTo(0, 3);
  expect(maxY(m)).toBeCloseTo(13, 1);
});

test('attribute arrays are consistent and ground/closure are dropped', () => {
  const m = mesh();
  const n = m.positions.length / 3;
  expect(n % 3).toBe(0);
  expect(m.normals.length).toBe(n * 3);
  expect(m.facadeUv.length).toBe(n * 2);
  expect(m.kind.length).toBe(n);
  expect(new Set(m.kind)).toEqual(new Set([0, 1]));
});

test('wall normals point away from centroid', () => {
  const m = mesh();
  let walls = 0;
  for (let t = 0; t < m.positions.length / 9; t++) {
    if (m.kind[t * 3] !== 0) continue;
    walls++;
    const p = (k: number, c: number) => m.positions[(t * 3 + k) * 3 + c]!;
    const mx = (p(0, 0) + p(1, 0) + p(2, 0)) / 3 - m.centroid.x;
    const mz = (p(0, 2) + p(1, 2) + p(2, 2)) / 3 - m.centroid.z;
    const dot = m.normals[t * 9]! * mx + m.normals[t * 9 + 2]! * mz;
    expect(dot).toBeGreaterThan(0);
    // winding agrees with stored normal
    const e1 = [p(1, 0) - p(0, 0), p(1, 1) - p(0, 1), p(1, 2) - p(0, 2)];
    const e2 = [p(2, 0) - p(0, 0), p(2, 1) - p(0, 1), p(2, 2) - p(0, 2)];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    expect(cx * m.normals[t * 9]! + cz * m.normals[t * 9 + 2]!).toBeGreaterThan(0);
  }
  expect(walls).toBeGreaterThan(0);
});

test('roof normals point up', () => {
  const m = mesh();
  for (let v = 0; v < m.kind.length; v++) if (m.kind[v] === 1) expect(m.normals[v * 3 + 1]).toBeGreaterThan(0);
});

test('facade v equals height above ground; u runs along the wall', () => {
  const m = mesh();
  let eaves = 0, maxU = 0;
  for (let v = 0; v < m.kind.length; v++) {
    if (m.kind[v] !== 0) continue;
    expect(m.facadeUv[v * 2 + 1]).toBeCloseTo(m.positions[v * 3 + 1]!, 5);
    if (Math.abs(m.positions[v * 3 + 1]! - 9) < 1e-4) eaves++;
    maxU = Math.max(maxU, m.facadeUv[v * 2]!);
  }
  expect(eaves).toBeGreaterThan(0);
  expect(maxU).toBeCloseTo(10, 3);
});

test('roof uv are world x/z', () => {
  const m = mesh();
  for (let v = 0; v < m.kind.length; v++) {
    if (m.kind[v] !== 1) continue;
    expect(m.facadeUv[v * 2]).toBeCloseTo(m.positions[v * 3]!, 5);
    expect(m.facadeUv[v * 2 + 1]).toBeCloseTo(m.positions[v * 3 + 2]!, 5);
  }
});

test('Neusser Str. flag set only for that street', () => {
  expect(mesh().flags & 1).toBe(1);
  expect(mesh().flags & 2).toBe(0);
  expect(buildBuildingMesh({ ...building(), street: 'Gladbacher Str.' })!.flags & 1).toBe(0);
  expect(buildBuildingMesh({ ...building(), street: undefined })!.flags & 1).toBe(0);
});

test('seed is stable, FNV-1a, differs per id', () => {
  const b = building();
  expect(buildBuildingMesh(b)!.buildingSeed).toBe(buildBuildingMesh(b)!.buildingSeed);
  expect(buildBuildingMesh({ ...b, id: '' })!.buildingSeed).toBe(0x811c9dc5);
  expect(buildBuildingMesh({ ...b, id: 'a' })!.buildingSeed).toBe(0xe40c292c);
  expect(buildBuildingMesh({ ...b, id: 'OTHER' })!.buildingSeed).not.toBe(buildBuildingMesh(b)!.buildingSeed);
});

test('returns null without usable surfaces', () => {
  expect(buildBuildingMesh({ ...building(), surfaces: [] })).toBeNull();
});

// Concave U-shaped house; its courtyard walls have inward (wrong) source winding.
function insideRing(r: { x: number; z: number }[], x: number, z: number) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!, b = r[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

test('concave U house: every wall normal points out of the footprint, windings agree', () => {
  const b = parseCityGml(read('u-house.gml'))[0]!;
  const fp = b.surfaces.find((s) => s.kind === 'ground')!.outer.map(([e, n]) => utmToLocal(e, n));
  const m = buildBuildingMesh(b)!;
  let walls = 0;
  for (let t = 0; t < m.positions.length / 9; t++) {
    if (m.kind[t * 3] !== 0) continue;
    walls++;
    const p = (k: number, c: number) => m.positions[(t * 3 + k) * 3 + c]!;
    const mx = (p(0, 0) + p(1, 0) + p(2, 0)) / 3, mz = (p(0, 2) + p(1, 2) + p(2, 2)) / 3;
    const nx = m.normals[t * 9]!, nz = m.normals[t * 9 + 2]!;
    expect(insideRing(fp, mx + nx * 0.3, mz + nz * 0.3)).toBe(false);
    const e1 = [p(1, 0) - p(0, 0), p(1, 1) - p(0, 1), p(1, 2) - p(0, 2)];
    const e2 = [p(2, 0) - p(0, 0), p(2, 1) - p(0, 1), p(2, 2) - p(0, 2)];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    expect(cx * nx + cz * nz).toBeGreaterThan(0);
  }
  expect(walls).toBe(16);
});

test('internal walls: probes both sides inside the footprint and roofs on both sides reach the wall top', () => {
  const sq = (x0: number, x1: number) => ({ outer: [{ x: x0, z: 0 }, { x: x1, z: 0 }, { x: x1, z: 10 }, { x: x0, z: 10 }], holes: [] });
  const footprint = [sq(0, 10), sq(10, 20)]; // two building parts sharing the edge x = 10
  const flatRoof = (x0: number, x1: number, y: number) => [x0, y, 0, x1, y, 0, x1, y, 10, x0, y, 0, x1, y, 10, x0, y, 10];
  const even = [...flatRoof(0, 10, 10), ...flatRoof(10, 20, 10)];
  const stepped = [...flatRoof(0, 10, 10), ...flatRoof(10, 20, 6)];
  const wall = (x: number, z0: number, z1: number, h: number) => [[x, 0, z0], [x, 0, z1], [x, h, z1], [x, h, z0]] as [number, number, number][];
  const east = { x: 1, z: 0 };
  // party wall of equal parts: hidden
  expect(isInternalWall(footprint, even, wall(10, 0, 10, 10), east)).toBe(true);
  // the tall part's wall rises above the lower part's roof: visible
  expect(isInternalWall(footprint, stepped, wall(10, 0, 10, 10), east)).toBe(false);
  // outer walls
  expect(isInternalWall(footprint, even, wall(0, 0, 10, 10), east)).toBe(false);
  expect(isInternalWall(footprint, even, wall(20, 0, 10, 10), east)).toBe(false);
  // a seam wall sticking out of the footprint at one end is visible there
  expect(isInternalWall(footprint, even, wall(10, 0, 14, 10), east)).toBe(false);
});

test('internal walls: a gable seam under a matching gable roof is hidden, one poking above it is not', () => {
  const footprint = [{ outer: [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 10 }, { x: 0, z: 10 }], holes: [] }];
  // gable roof, ridge along x at z = 5 (y 13), eaves at z = 0 / 10 (y 9)
  const roof = [0, 9, 0, 20, 9, 0, 20, 13, 5, 0, 9, 0, 20, 13, 5, 0, 13, 5, 0, 13, 5, 20, 13, 5, 20, 9, 10, 0, 13, 5, 20, 9, 10, 0, 9, 10];
  const gable = (apex: number) => [[10, 0, 0], [10, 0, 10], [10, 9, 10], [10, apex, 5], [10, 9, 0]] as [number, number, number][];
  expect(isInternalWall(footprint, roof, gable(13), { x: 1, z: 0 })).toBe(true);
  expect(isInternalWall(footprint, roof, gable(14), { x: 1, z: 0 })).toBe(false);
});

// ---- absolute heights with terrain (gable house: LoD2 minZ = 40) ----

const DATUM = 35;
const BASE = 40 - DATUM;

/** Corners of the gable-house footprint in local coordinates. */
function footprintBox() {
  const pts = [[356000, 5647000], [356010, 5647000], [356010, 5647008], [356000, 5647008]].map(([e, n]) => utmToLocal(e!, n!));
  const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** 1 m grid around the house with heights f(x, z). */
function grid(f: (x: number, z: number) => number): TerrainGrid {
  const b = footprintBox();
  const x0 = Math.floor(b.minX) - 3, z0 = Math.floor(b.minZ) - 3;
  const cols = Math.ceil(b.maxX) + 4 - x0, rows = Math.ceil(b.maxZ) + 4 - z0;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = f(x0 + c, z0 + r);
  return { x0, z0, cols, rows, datum: DATUM, heights };
}

const groundOf = (f: (x: number, z: number) => number) => ({ datum: DATUM, terrain: grid(f) });
const wallVerts = (m: BuildingMesh) => Array.from({ length: m.kind.length }, (_, v) => v).filter((v) => m.kind[v] === 0);

test('absolute height with terrain', () => {
  const m = buildBuildingMesh(building(), groundOf(() => BASE))!;
  expect(m.base).toBeCloseTo(BASE, 6);
  // ground exactly at the base still lies < 0.3 m above it, so a plinth is added; check the LoD2 wall itself (v >= 0)
  const walls = wallVerts(m);
  const own = walls.filter((v) => m.facadeUv[v * 2 + 1]! >= -1e-6);
  const low = Math.min(...own.map((v) => m.positions[v * 3 + 1]!));
  expect(Math.abs(low - BASE)).toBeLessThan(1e-4);
  expect(Math.abs(maxY(m) - (53 - DATUM))).toBeLessThan(1e-3);
  for (const v of walls) {
    const y = m.positions[v * 3 + 1]!;
    expect(Math.abs(m.facadeUv[v * 2 + 1]! - (y - BASE))).toBeLessThan(1e-4);
    if (Math.abs(y - BASE) < 1e-4) expect(Math.abs(m.facadeUv[v * 2 + 1]!)).toBeLessThan(1e-4);
  }
});

test('no plinth on level ground', () => {
  const m = buildBuildingMesh(building(), groundOf(() => BASE + 0.5))!;
  for (let v = 0; v < m.kind.length; v++) if (m.kind[v] === 0) expect(m.facadeUv[v * 2 + 1]!).toBeGreaterThanOrEqual(-1e-6);
  expect(Math.abs(minY(m) - BASE)).toBeLessThan(1e-4);
});

test('plinth closes the gap to lower terrain', () => {
  const b = footprintBox();
  // falls linearly along x from BASE (west edge) to BASE - 1.5 (east edge)
  const m = buildBuildingMesh(building(), groundOf((x) => BASE - (1.5 * (x - b.minX)) / (b.maxX - b.minX)))!;
  const n = m.positions.length / 9;
  const v = (t: number, k: number) => m.facadeUv[(t * 3 + k) * 2 + 1]!;
  const y = (t: number, k: number) => m.positions[(t * 3 + k) * 3 + 1]!;
  let plinthTris = 0, bottomEdges = 0, deepest = 0;
  const wallNormals: [number, number, number][] = [];
  const plinthNormals: [number, number, number][] = [];
  for (let t = 0; t < n; t++) {
    if (m.kind[t * 3] !== 0) continue;
    const nrm = [m.normals[t * 9]!, m.normals[t * 9 + 1]!, m.normals[t * 9 + 2]!] as [number, number, number];
    if ([0, 1, 2].some((k) => v(t, k) < -1e-6)) {
      plinthTris++;
      plinthNormals.push(nrm);
      for (let k = 0; k < 3; k++) if (Math.abs(y(t, k) - (BASE - 1.8)) < 1e-4) deepest++;
      continue;
    }
    wallNormals.push(nrm);
    // all gable-house walls stand on z = 40, i.e. y = BASE
    for (let k = 0; k < 3; k++) if (Math.abs(y(t, k) - BASE) < 0.05 && Math.abs(y(t, (k + 1) % 3) - BASE) < 0.05) bottomEdges++;
  }
  expect(deepest).toBeGreaterThan(0);
  expect(bottomEdges).toBeGreaterThan(0);
  expect(plinthTris).toBe(2 * bottomEdges);
  for (const pn of plinthNormals) {
    expect(wallNormals.some((wn) => Math.abs(wn[0] - pn[0]) < 1e-6 && Math.abs(wn[1] - pn[1]) < 1e-6 && Math.abs(wn[2] - pn[2]) < 1e-6)).toBe(true);
  }
  // plinth vertices: facade v = y - base, never below the plinth bottom
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    if (m.kind[t * 3] !== 0) continue;
    expect(Math.abs(v(t, k) - (y(t, k) - BASE))).toBeLessThan(1e-4);
    expect(y(t, k)).toBeGreaterThan(BASE - 1.8 - 1e-4);
  }
  // winding agrees with the stored normal on every plinth triangle
  for (let t = 0; t < n; t++) {
    if (m.kind[t * 3] !== 0 || ![0, 1, 2].some((k) => v(t, k) < -1e-6)) continue;
    const p = (k: number, c: number) => m.positions[(t * 3 + k) * 3 + c]!;
    const e1 = [p(1, 0) - p(0, 0), p(1, 1) - p(0, 1), p(1, 2) - p(0, 2)];
    const e2 = [p(2, 0) - p(0, 0), p(2, 1) - p(0, 1), p(2, 2) - p(0, 2)];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    expect(cx * m.normals[t * 9]! + cz * m.normals[t * 9 + 2]!).toBeGreaterThan(0);
  }
});

test('without terrain unchanged', () => {
  const m = mesh();
  expect(m.base).toBe(0);
  const walls = wallVerts(m);
  expect(Math.abs(Math.min(...walls.map((v) => m.positions[v * 3 + 1]!)))).toBeLessThan(1e-6);
  for (const v of walls) {
    expect(Math.abs(m.facadeUv[v * 2 + 1]! - m.positions[v * 3 + 1]!)).toBeLessThan(1e-6);
    expect(m.facadeUv[v * 2 + 1]!).toBeGreaterThanOrEqual(0);
  }
});

test('no plinth below a wall that stands on a lower part\'s roof', () => {
  // 10 x 8 m block, 4 m high (flat roof at z 44); on top a 6 m wall at e = 356005 (bottom 44, top 50)
  const E = 356000, N = 5647000, Z = 40;
  const box = (e0: number, e1: number, n0: number, n1: number, z0: number, z1: number) => [
    { kind: 'wall' as const, outer: [[e0, n0, z0], [e1, n0, z0], [e1, n0, z1], [e0, n0, z1]] as [number, number, number][], holes: [] },
    { kind: 'wall' as const, outer: [[e1, n0, z0], [e1, n1, z0], [e1, n1, z1], [e1, n0, z1]] as [number, number, number][], holes: [] },
    { kind: 'wall' as const, outer: [[e1, n1, z0], [e0, n1, z0], [e0, n1, z1], [e1, n1, z1]] as [number, number, number][], holes: [] },
    { kind: 'wall' as const, outer: [[e0, n1, z0], [e0, n0, z0], [e0, n0, z1], [e0, n1, z1]] as [number, number, number][], holes: [] },
  ];
  const b = {
    ...building(),
    surfaces: [
      { kind: 'ground' as const, outer: [[E, N, Z], [E, N + 8, Z], [E + 10, N + 8, Z], [E + 10, N, Z]] as [number, number, number][], holes: [] },
      ...box(E, E + 10, N, N + 8, Z, Z + 4),
      { kind: 'roof' as const, outer: [[E, N, Z + 4], [E + 10, N, Z + 4], [E + 10, N + 8, Z + 4], [E, N + 8, Z + 4]] as [number, number, number][], holes: [] },
      { kind: 'wall' as const, outer: [[E + 5, N + 2, Z + 4], [E + 5, N + 6, Z + 4], [E + 5, N + 6, Z + 10], [E + 5, N + 2, Z + 10]] as [number, number, number][], holes: [] },
    ],
  };
  const fp = footprintBox();
  const m = buildBuildingMesh(b, groundOf((x) => BASE - (1.5 * (x - fp.minX)) / (fp.maxX - fp.minX)))!;
  const upper = utmToLocal(E + 5, N + 4);
  // the upper wall is emitted…
  let upperWall = 0, plinthNearUpper = 0, plinthTris = 0;
  for (let t = 0; t < m.positions.length / 9; t++) {
    if (m.kind[t * 3] !== 0) continue;
    const xs = [0, 1, 2].map((k) => m.positions[(t * 3 + k) * 3]!);
    const zs = [0, 1, 2].map((k) => m.positions[(t * 3 + k) * 3 + 2]!);
    const vs = [0, 1, 2].map((k) => m.facadeUv[(t * 3 + k) * 2 + 1]!);
    const onUpper = xs.every((x) => Math.abs(x - upper.x) < 0.01) && zs.every((z) => Math.abs(z - upper.z) < 2.01);
    if (vs.some((v) => v < -1e-6)) {
      plinthTris++;
      if (onUpper) plinthNearUpper++;
    } else if (onUpper) upperWall++;
  }
  expect(upperWall).toBeGreaterThan(0);
  // …but only the four outer walls (one bottom edge each) get plinths
  expect(plinthNearUpper).toBe(0);
  expect(plinthTris).toBe(8);
});

test('plinth depth follows a dip in the middle of a wall', () => {
  // terrain at the base except a 2 m deep dip in the middle of the south wall (n = 5647000, e = 356005)
  const dip = utmToLocal(356005, 5647000);
  const m = buildBuildingMesh(building(), groundOf((x, z) => (Math.hypot(x - dip.x, z - dip.z) < 0.5 ? BASE - 2 : BASE)))!;
  expect(Math.abs(minY(m) - (BASE - 2.3))).toBeLessThan(1e-3);
});
