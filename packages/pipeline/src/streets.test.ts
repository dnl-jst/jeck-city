import { expect, test } from 'vitest';
import { boxBuilding, loadFixture } from './fixture.js';
import { crossSectionFromTags, type CrossSection } from './crosssection.js';
import type { Road } from './osm.js';
import { distToPolyline } from './polyline.js';
import { allSidewalkWidths } from './sidewalkwidth.js';
import { buildStreetGeometry, type Mesh } from './streets.js';
import { wgs84ToLocal } from '@nn/shared';

const f = loadFixture();
const g = buildStreetGeometry(f);
const verts = (m: Mesh) => Array.from({ length: m.positions.length / 3 }, (_, i) => ({ x: m.positions[i * 3]!, y: m.positions[i * 3 + 1]!, z: m.positions[i * 3 + 2]! }));
const crossing = wgs84ToLocal(50.9631, 6.952);

test('every mesh is consistent: indices in range, uv per vertex', () => {
  for (const [name, m] of Object.entries(g)) {
    expect(m.positions.length % 3).toBe(0);
    expect(m.uv.length / 2).toBe(m.positions.length / 3);
    expect(m.indices.length % 3).toBe(0);
    if (name !== 'parking') expect(m.indices.length).toBeGreaterThan(0); // the fixture has no parking strips
    expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
  }
});

test('road ribbons lie at y=0.01 plus at most 0.005', () => {
  for (const v of verts(g.road)) {
    expect(v.y).toBeGreaterThanOrEqual(0.01 - 1e-6);
    expect(v.y).toBeLessThanOrEqual(0.015 + 1e-6);
  }
});

test('all ribbon/polygon triangles face up (horizontal meshes)', () => {
  for (const m of [g.road, g.sidewalk, g.tram, g.green, g.squares, g.markings]) {
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.indices[i + k]! * 3);
      const ux = m.positions[b!]! - m.positions[a!]!, uz = m.positions[b! + 2]! - m.positions[a! + 2]!;
      const vx = m.positions[c!]! - m.positions[a!]!, vz = m.positions[c! + 2]! - m.positions[a! + 2]!;
      expect(uz * vx - ux * vz).toBeGreaterThanOrEqual(0);
    }
  }
});

test('curb is 0.12 m high, sidewalk at 0.12, none within 5 m of the junction', () => {
  const curb = verts(g.curb);
  expect(Math.max(...curb.map((v) => v.y))).toBeCloseTo(0.12, 5);
  expect(verts(g.sidewalk).every((v) => Math.abs(v.y - 0.12) < 1e-6)).toBe(true);
  for (const v of [...curb, ...verts(g.sidewalk)]) {
    expect(Math.hypot(v.x - crossing.x, v.z - crossing.z)).toBeGreaterThanOrEqual(5 - 1e-3);
  }
  // but kerbs exist further out
  expect(curb.some((v) => Math.hypot(v.x - crossing.x, v.z - crossing.z) > 20)).toBe(true);
});

test('footways get no kerb or sidewalk', () => {
  const foot = wgs84ToLocal(50.9628, 6.9515);
  const near = (v: { x: number; z: number }) => Math.hypot(v.x - foot.x, v.z - foot.z) < 4;
  expect(verts(g.curb).some(near)).toBe(false);
  expect(verts(g.sidewalk).some(near)).toBe(false);
});

test('tram has two rails with 1.435 m gauge', () => {
  const t = wgs84ToLocal(50.9636, 6.952);
  const zs = verts(g.tram).filter((v) => Math.abs(v.x - t.x) < 0.5).map((v) => v.z);
  const lo = zs.filter((z) => z < t.z), hi = zs.filter((z) => z > t.z);
  expect(lo.length).toBeGreaterThan(0);
  expect(hi.length).toBeGreaterThan(0);
  const centre = (a: number[]) => (Math.min(...a) + Math.max(...a)) / 2;
  expect(centre(hi) - centre(lo)).toBeCloseTo(1.435, 2);
});

test('uv: u runs in metres along the road', () => {
  const m = g.road;
  const maxU = Math.max(...Array.from({ length: m.uv.length / 2 }, (_, i) => m.uv[i * 2]!));
  expect(maxU).toBeGreaterThan(190); // Querstraße is ~200 m
  expect(maxU).toBeLessThan(210);
});

const road1 = (f0: ReturnType<typeof loadFixture>, name: string) => f0.roads.find((r) => r.name === name)!;

test('road ribbon is as wide as the carriageway from the cross-section', () => {
  const t = road1(f, 'Teststraße');
  expect(t.width).toBeCloseTo(6.0, 6); // residential: 2 × 3.0 m
  const at = wgs84ToLocal(50.9631, 6.951); // western end
  const zs = verts(g.road).filter((v) => Math.abs(v.x - at.x) < 0.5 && Math.abs(v.z - at.z) < 10).map((v) => v.z);
  expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(6.0, 2);
});

test('sidewalk reaches the facade: building 4 m behind the kerb → outer edge on the facade', () => {
  const cross = crossSectionFromTags({}, 'residential'); // 6.0 m, kerbs at z = ±3
  const r: Road = { id: 1, kind: 'residential', points: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], width: cross.carriageway, oneway: false, lanes: 2, cross };
  const geo = buildStreetGeometry({ ...f, roads: [r], greens: [], squares: [], tramTracks: [] }, allSidewalkWidths([r], [boxBuilding('S', -10, 7, 110, 30, 12)]));
  const south = verts(geo.sidewalk).filter((v) => v.z > 0);
  const north = verts(geo.sidewalk).filter((v) => v.z < 0);
  expect(Math.max(...south.map((v) => v.z))).toBeCloseTo(7, 4);
  expect(Math.min(...south.map((v) => v.z))).toBeCloseTo(3.15, 4); // starts behind the kerb stone
  expect(Math.min(...north.map((v) => v.z))).toBeCloseTo(-3 - 2.5, 4); // no building: 2.5 m
});

test('dual carriageway: no kerb or sidewalk between the two oneway ways, a green median instead', () => {
  const [s1, s2] = f.roads.filter((r) => r.name === 'Doppelstraße');
  const gap = distToPolyline(s1!.points[0]!, s2!.points); // ≈ 11.1 m centre to centre
  const ds = (v: { x: number; z: number }) => [distToPolyline(v, s1!.points), distToPolyline(v, s2!.points)] as const;
  const between = (v: { x: number; z: number }) => {
    const [a, b] = ds(v);
    return a + b < gap + 0.01 && a > 3.25 - 1e-3 && b > 3.25 - 1e-3;
  };
  const outside = (v: { x: number; z: number }) => {
    const [a, b] = ds(v);
    return Math.min(a, b) > 3.25 && Math.min(a, b) < 10 && a + b > gap + 1;
  };
  expect(verts(g.sidewalk).some(between)).toBe(false);
  expect(verts(g.curb).some(between)).toBe(false);
  expect(verts(g.green).filter(between).length).toBeGreaterThanOrEqual(4);
  expect(verts(g.sidewalk).filter(outside).length).toBeGreaterThanOrEqual(4); // outer sides keep their sidewalks
});

test('sidewalks of a side street stop before a wide crossing carriageway', () => {
  const c = crossSectionFromTags({ lanes: '4', 'cycleway:both': 'lane', 'parking:both': 'lane' }, 'secondary'); // 20.2 m
  const mk = (id: number, kind: string, pts: [number, number][], cross: CrossSection): Road =>
    ({ id, kind, points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: false, lanes: 2, cross });
  const wide = mk(1, 'secondary', [[-100, 0], [0, 0], [100, 0]], c);
  const side = mk(2, 'residential', [[0, 0], [0, 100]], crossSectionFromTags({}, 'residential'));
  const geo = buildStreetGeometry({ ...f, roads: [wide, side], greens: [], squares: [], tramTracks: [] });
  const hw = c.carriageway / 2;
  for (const v of [...verts(geo.sidewalk), ...verts(geo.curb)]) {
    if (Math.abs(v.x) < 10) expect(Math.abs(v.z)).toBeGreaterThanOrEqual(hw - 1e-3); // side street parts
  }
  for (const v of verts(geo.sidewalk)) {
    if (Math.abs(v.z) > hw + 0.2) expect(Math.abs(v.x)).toBeGreaterThanOrEqual(3 + 0.15 - 1e-3); // wide road's sidewalks clear the side street
  }
});

test('parking strip: own surface along the kerb, v = metres from the kerb, just above the road', () => {
  const cross = crossSectionFromTags({ 'parking:right': 'lane' }, 'residential'); // lanes ±3.0, strip 3..5 on the right
  const r: Road = { id: 1, kind: 'residential', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }], width: cross.carriageway, oneway: false, lanes: 2, cross };
  const geo = buildStreetGeometry({ ...f, roads: [r], greens: [], squares: [], tramTracks: [] });
  const v = verts(geo.parking);
  expect(v.length).toBeGreaterThan(0);
  const roadY = verts(geo.road)[0]!.y;
  v.forEach((p, i) => {
    expect(p.z).toBeGreaterThanOrEqual(3 - 1e-4); // right of travel (east) is +z
    expect(p.z).toBeLessThanOrEqual(5 + 1e-4);
    expect(geo.parking.uv[i * 2 + 1]).toBeCloseTo(5 - p.z, 4);
    expect(p.y).toBeCloseTo(roadY + 0.002, 6);
  });
  expect(v.some((p) => Math.abs(p.z - 3) < 1e-4)).toBe(true);
  expect(geo.markings.indices.length).toBe(0); // residential, no cycle lanes: no markings
});

test('markings come out of buildStreetGeometry with a mark per vertex', () => {
  expect(g.markings.mark!.length).toBe(g.markings.positions.length / 3);
  expect(g.markings.indices.length).toBeGreaterThan(0); // Doppelstraße: lane dividers
});

const mkRoad = (id: number, kind: string, pts: [number, number][], tags: Record<string, string>, name?: string): Road => {
  const cross = crossSectionFromTags(tags, kind);
  return { id, name, kind, points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: tags.oneway === 'yes', lanes: 2, cross };
};

test('a side street\'s sidewalks stop at the crossing road\'s kerb on their own side, not at its wider other side', () => {
  // main road along x: 2 × 3.25 m lanes, a 4.5 m diagonal strip on the right (+z): kerbs at z = -3.25 and +7.75
  const main = mkRoad(1, 'secondary', [[-100, 0], [0, 0], [100, 0]], { lanes: '2', 'parking:right': 'yes', 'parking:right:orientation': 'diagonal' });
  const side = mkRoad(2, 'residential', [[0, 0], [0, -100]], {}); // leaves to the north (-z), the narrow side
  const geo = buildStreetGeometry({ ...f, roads: [main, side], greens: [], squares: [], tramTracks: [] });
  const sideWalk = verts(geo.sidewalk).filter((v) => Math.abs(v.x) < 4.9 && v.z < 0); // the main road's sidewalks end 5 m from the side street
  expect(Math.max(...sideWalk.map((v) => v.z))).toBeGreaterThan(-5.01); // from the 5 m junction gap on, not from beyond 7.9 m
});

test('dual carriageway detection uses the kerbs facing each other: wide outer strips do not merge two separate roads', () => {
  // two oneways 12 m apart, each 3.25 m lane with a 5 m perpendicular strip on its outer side; inner kerbs 1.625 m
  const tags = { oneway: 'yes', 'parking:right': 'yes', 'parking:right:orientation': 'perpendicular' };
  const east = mkRoad(1, 'secondary', [[-100, 0], [0, 0], [100, 0]], tags, 'Ring');
  const west = mkRoad(2, 'secondary', [[100, -12], [0, -12], [-100, -12]], tags, 'Ring');
  const geo = buildStreetGeometry({ ...f, roads: [east, west], greens: [], squares: [], tramTracks: [] });
  expect(verts(geo.green).length).toBe(0);
  expect(verts(geo.sidewalk).filter((v) => v.z < -1.625 - 0.1 && v.z > -12 + 1.625 + 0.1).length).toBeGreaterThan(4);
});

test('long way segment along a stepped facade: the sidewalk gets vertices between the way\'s vertices and stays out of the buildings', () => {
  const r = mkRoad(1, 'residential', [[0, 0], [60, 0]], {}); // kerbs at z = ±3
  const b = [boxBuilding('A', -10, 7, 20, 30, 12), boxBuilding('B', 20, 5, 40, 30, 12), boxBuilding('C', 40, 8, 70, 30, 12)];
  const geo = buildStreetGeometry({ ...f, roads: [r], greens: [], squares: [], tramTracks: [] }, allSidewalkWidths([r], b));
  const south = verts(geo.sidewalk).filter((v) => v.z > 0);
  expect(south.some((v) => v.x > 1 && v.x < 59)).toBe(true); // outer-edge vertices at the facade steps
  const facade = (x: number) => (x < 20 ? 7 : x <= 40 ? 5 : 8);
  for (const v of south) expect(v.z).toBeLessThanOrEqual(Math.min(facade(v.x - 1e-3), facade(v.x + 1e-3)) + 1e-3);
  expect(Math.max(...south.filter((v) => v.x < 16).map((v) => v.z))).toBeCloseTo(7, 3); // on the facade before the step
});

test('an overridden building still bounds the sidewalk: an override drops its mesh from the chunks, not its building line', async () => {
  const { buildChunks } = await import('./chunks.js');
  const r = mkRoad(1, 'residential', [[0, 10], [40, 10]], {}); // kerbs at z = 7 and 13
  const church = boxBuilding('church', 5, 16, 35, 40, 20); // facade 3 m behind the south kerb
  const overrides = { church: 'data/models/church.glb' };
  const streets = buildStreetGeometry({ ...f, roads: [r], greens: [], squares: [], tramTracks: [] }, allSidewalkWidths([r], [church]));
  const chunk = buildChunks([church], streets, overrides).find((c) => c.streets.sidewalk)!;
  expect(chunk.buildings).toBeUndefined(); // the model replaces the LoD2 mesh …
  const sw = chunk.streets.sidewalk!;
  for (let i = 0; i < sw.positions.length; i += 3) expect(sw.positions[i + 2]!).toBeLessThanOrEqual(16 + 1e-4); // … the sidewalk still ends at its facade
});
