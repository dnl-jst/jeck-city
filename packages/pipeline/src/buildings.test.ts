import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { buildBuildingMesh, isInternalWall, type BuildingMesh } from './buildings.js';
import { parseCityGml } from './citygml.js';
import { utmToLocal } from '@nn/shared';

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
