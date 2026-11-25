import { expect, test } from 'vitest';
import { buildCollision } from './chunks.js';
import { crossSectionFromTags } from './crosssection.js';
import { boxRecord, loadFixture } from './fixture.js';
import { buildMarkings } from './markings.js';
import type { OsmFeatures, Road } from './osm.js';
import { parkedCarSpots } from './parking.js';
import { edgeAt, sideOffsets, withProfiles } from './roadprofile.js';
import { sidewalkWidths } from './sidewalkwidth.js';
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
const g = buildStreetGeometry(f);
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

test('collision: no kerb cross face at the split', async () => {
  const col = await buildCollision({ buildings: [], curb: g.curb, sidewalk: g.sidewalk, boundary: f.boundary });
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

test('collision: kerb and sidewalk run on continuously across the split (no step, no hole)', async () => {
  const col = await buildCollision({ buildings: [], curb: g.curb, sidewalk: g.sidewalk, boundary: f.boundary });
  const v = col.vertices, idx = col.indices;
  /** Expected kerb distance per side at x (ramps: left in A over [-6, 0], right in B over [0, 6]). */
  const kerb = (side: number, x: number) => side < 0
    ? (x <= -6 ? 6.85 : x >= 0 ? 4.85 : 6.85 - ((x + 6) / 6) * 2)
    : (x <= 0 ? 6.85 : x >= 6 ? 9.35 : 6.85 + (x / 6) * 2.5);
  // inner kerb line of the collision: the bottom vertices of the kerb faces (curb and sidewalk are the only
  // street surfaces in the collision, so y < 0.05 is exactly the foot of the kerb face)
  for (const side of [-1, 1]) {
    const by = new Map<string, number[]>();
    for (let i = 0; i < v.length; i += 3) {
      if (Math.abs(v[i]!) > 150 || v[i + 1]! > 0.05 || Math.sign(v[i + 2]!) !== side) continue;
      const k = v[i]!.toFixed(3);
      by.set(k, [...(by.get(k) ?? []), Math.abs(v[i + 2]!)]);
    }
    const line = [...by].map(([x, ds]) => ({ x: Number(x), ds })).sort((a, b) => a.x - b.x);
    expect(line.length).toBeGreaterThan(1);
    for (const p of line) expect(Math.max(...p.ds) - Math.min(...p.ds)).toBeLessThan(1e-3); // two kerb ends at one x = a step
    for (let i = 1; i < line.length; i++) {
      expect(Math.abs(line[i]!.ds[0]! - line[i - 1]!.ds[0]!)).toBeLessThanOrEqual((line[i]!.x - line[i - 1]!.x) * (2.5 / 6) + 1e-3);
    }
    // every point just behind the kerb is covered by a collision surface at pavement height
    for (let x = -15; x <= 15; x += 0.25) {
      const p = { x, z: side * (kerb(side, x) + 0.4) };
      let hit = false;
      for (let t = 0; t < idx.length && !hit; t += 3) {
        const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3];
        if (Math.abs(v[a + 1]! - 0.12) > 1e-3 || Math.abs(v[b + 1]! - 0.12) > 1e-3 || Math.abs(v[c + 1]! - 0.12) > 1e-3) continue;
        const cr = (i: number, j: number) => (v[j]! - v[i]!) * (p.z - v[i + 2]!) - (v[j + 2]! - v[i + 2]!) * (p.x - v[i]!);
        const s1 = cr(a, b), s2 = cr(b, c), s3 = cr(c, a);
        hit = (s1 >= -1e-6 && s2 >= -1e-6 && s3 >= -1e-6) || (s1 <= 1e-6 && s2 <= 1e-6 && s3 <= 1e-6);
      }
      expect(hit, `no pavement at x=${x}, side ${side}`).toBe(true);
    }
  }
});

test('sidewalk outer edge stays on the facade through a ramp (width filled as distance to the outer edge)', () => {
  const walls = [boxRecord('N', -200, -40, 200, -12, 10), boxRecord('S', -200, 12, 200, 40, 10)]; // widths 2.65..7.15 m, inside the 1.5..8 m clamp
  for (const r of roads) {
    const w = sidewalkWidths(r, walls);
    for (const side of [-1, 1]) (side > 0 ? w.right : w.left).forEach((wi, i) => expect(edgeAt(r, side, 'kerb', w.s[i]!) + wi).toBeCloseTo(12, 2));
  }
});

// 2+1 lanes (way A) continuing as 1+1 (way B): the centre line ramps with the lanes, A's extra divider ends at the ramp
const A2 = mk(11, [[-200, 0], [-100, 0], [0, 0]], { 'lanes:forward': '2', 'lanes:backward': '1' });
const B2 = mk(12, [[0, 0], [100, 0], [200, 0]], { lanes: '2' });
const lanesRoads = withProfiles([A2, B2]);

test('lane count change: centre line ramps to the narrower way, no jump; the extra divider ends at the ramp', () => {
  const pieces = buildMarkings(lanesRoads, () => 0.01).pieces;
  const expected = (x: number) => (x <= -6 ? -1.625 : x >= 0 ? 0 : -1.625 * (-x / 6)); // left of travel is -z
  const centre = pieces.filter((p) => p.kind === 'centre');
  expect(centre.some((p) => p.x > -6 && p.x < 0)).toBe(true);
  for (const p of centre) expect(Math.abs(p.z - expected(p.x))).toBeLessThan(0.05);
  const lanes = pieces.filter((p) => p.kind === 'lane');
  expect(lanes.length).toBeGreaterThan(0);
  for (const p of lanes) {
    expect(p.road).toBe(11);
    expect(p.s1).toBeLessThanOrEqual(200 - 6 + 1e-6); // ends at the start of the ramp
    expect(Math.abs(p.z - (-1.625 + 3.25))).toBeLessThan(0.05); // one lane width right of the centre line
  }
});
