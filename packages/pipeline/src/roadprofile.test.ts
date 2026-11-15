import { expect, test } from 'vitest';
import { buildCollision } from './chunks.js';
import { crossSectionFromTags } from './crosssection.js';
import { loadFixture } from './fixture.js';
import { buildMarkings } from './markings.js';
import type { OsmFeatures, Road } from './osm.js';
import { parkedCarSpots } from './parking.js';
import { sideOffsets, withProfiles } from './roadprofile.js';
import { buildStreetGeometry, type Mesh } from './streets.js';

const mk = (id: number, pts: [number, number][], tags: Record<string, string>): Road => {
  const cross = crossSectionFromTags(tags, 'secondary');
  return { id, name: 'Neusser Straße', kind: 'secondary', points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: false, lanes: 2, cross };
};
// way direction +x: right of travel = +z, left = -z. A: strips both sides; B: diagonal strip right, none left.
const A = mk(1, [[-200, 0], [-100, 0], [0, 0]], { lanes: '2', 'cycleway:both': 'lane', 'parking:both': 'lane' });
const B = mk(2, [[0, 0], [100, 0], [200, 0]], { lanes: '2', 'cycleway:both': 'lane', 'parking:right': 'yes', 'parking:right:orientation': 'diagonal', 'parking:left': 'no' });
const roads = withProfiles([A, B]);
const f: OsmFeatures = {
  ...loadFixture(), roads, tramTracks: [], tramStops: [], greens: [], squares: [],
  boundary: [{ x: -300, z: -300 }, { x: 300, z: -300 }, { x: 300, z: 300 }, { x: -300, z: 300 }],
};
const g = buildStreetGeometry(f, []);
const verts = (m: Mesh) => Array.from({ length: m.positions.length / 3 }, (_, i) => ({ x: m.positions[i * 3]!, y: m.positions[i * 3 + 1]!, z: m.positions[i * 3 + 2]! }));
/** Inner kerb edge on one side (sign of z): per distinct x, the curb vertex nearest to the axis. */
function kerbLine(side: number): { x: number; d: number }[] {
  const by = new Map<string, number>();
  for (const v of verts(g.curb)) {
    if (Math.sign(v.z) !== side) continue;
    const k = v.x.toFixed(3);
    by.set(k, Math.min(by.get(k) ?? Infinity, Math.abs(v.z)));
  }
  return [...by].map(([x, d]) => ({ x: Number(x), d })).sort((a, b) => a.x - b.x);
}

test('sideOffsets: lanes symmetric about the centre line, cycle lane and strip added outwards per side', () => {
  const o = sideOffsets(B.cross);
  expect(o.left).toEqual({ lane: 3.25, cycle: 4.85, kerb: 4.85 });
  expect(o.right.lane).toBeCloseTo(3.25, 6);
  expect(o.right.cycle).toBeCloseTo(4.85, 6);
  expect(o.right.kerb).toBeCloseTo(9.35, 6);
});

test('centre line of both ways on one line across the split', () => {
  const centre = buildMarkings(roads, () => 0.01).pieces.filter((p) => p.kind === 'centre');
  expect(new Set(centre.map((p) => p.road))).toEqual(new Set([1, 2]));
  for (const p of centre) expect(Math.abs(p.z)).toBeLessThan(0.05);
});

test('left kerb moves by the dropped parking strip only, over a ramp ≥ 6 m, never as a step', () => {
  const k = kerbLine(-1);
  const before = k.filter((p) => p.x < -20), after = k.filter((p) => p.x > 20);
  for (const p of before) expect(p.d).toBeCloseTo(6.85, 3);
  for (const p of after) expect(p.d).toBeCloseTo(4.85, 3);
  expect(k.some((p) => Math.abs(p.x) < 1e-3 && Math.abs(p.d - 4.85) < 1e-3)).toBe(true); // the kerb runs on through the split
  // the change happens over ≥ 6 m (slope ≤ 2 m / 6 m), with no gap
  const lastWide = Math.max(...k.filter((p) => p.d > 6.84).map((p) => p.x));
  const firstNarrow = Math.min(...k.filter((p) => p.d < 4.86).map((p) => p.x));
  expect(firstNarrow - lastWide).toBeGreaterThanOrEqual(6 - 1e-3);
  for (let i = 1; i < k.length; i++) {
    const dx = k[i]!.x - k[i - 1]!.x;
    expect(Math.abs(k[i]!.d - k[i - 1]!.d)).toBeLessThanOrEqual(dx * (2 / 6) + 1e-3); // no cross edge
  }
});

test('right kerb: the diagonal strip opens over a ramp in the wider way', () => {
  const k = kerbLine(1);
  for (const p of k.filter((q) => q.x < -1)) expect(p.d).toBeCloseTo(6.85, 3);
  for (const p of k.filter((q) => q.x > 20)) expect(p.d).toBeCloseTo(9.35, 3);
  for (let i = 1; i < k.length; i++) {
    const dx = k[i]!.x - k[i - 1]!.x;
    expect(Math.abs(k[i]!.d - k[i - 1]!.d)).toBeLessThanOrEqual(dx * (2.5 / 6) + 1e-3);
  }
});

test('collision: no kerb cross face at the split', () => {
  const col = buildCollision({ buildings: [], curb: g.curb, sidewalk: g.sidewalk, boundary: f.boundary });
  const v = col.vertices, idx = col.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3];
    const cx = (v[a]! + v[b]! + v[c]!) / 3, cz = (v[a + 2]! + v[b + 2]! + v[c + 2]!) / 3;
    if (Math.abs(cx) > 15 || Math.abs(cz) > 15) continue;
    const ux = v[b]! - v[a]!, uy = v[b + 1]! - v[a + 1]!, uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!, wy = v[c + 1]! - v[a + 1]!, wz = v[c + 2]! - v[a + 2]!;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    // a face standing across the road (normal along x) would be a kerb step
    expect(Math.abs(nx / l)).toBeLessThan(0.7);
  }
});

test('no parked car in a ramp', () => {
  const spots = parkedCarSpots(f, 7, []);
  expect(spots.length).toBeGreaterThan(0);
  for (const s of spots) expect(Math.abs(s.pos.x)).toBeGreaterThan(6 + 2.1);
});
