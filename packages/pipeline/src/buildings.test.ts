import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { parseCityGml } from './citygml.js';

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
