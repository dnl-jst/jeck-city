import { expect, test } from 'vitest';
import { crossSectionFromTags } from './crosssection.js';
import { loadFixture } from './fixture.js';
import type { OsmFeatures, Road } from './osm.js';
import { parkedCarSpots } from './parking.js';
import { sideOffsets } from './roadprofile.js';

const mk = (id: number, kind: string, pts: [number, number][], tags: Record<string, string> = {}): Road => {
  const cross = crossSectionFromTags(tags, kind);
  return { id, kind, points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: tags.oneway === 'yes', lanes: cross.lanesForward + cross.lanesBackward, cross };
};
const world = (roads: Road[]): OsmFeatures => ({
  ...loadFixture(), roads, tramTracks: [], tramStops: [],
  boundary: [{ x: -500, z: -500 }, { x: 500, z: -500 }, { x: 500, z: 500 }, { x: -500, z: 500 }],
});
// way runs east (+x): right of travel = (-dz, dx) = +z, left = -z
const ROAD: [number, number][] = [[-200, 0], [200, 0]];
const fwd = (h: number) => ({ x: Math.sin(h), z: Math.cos(h) });
/** Gaps between neighbouring cars along x are whole multiples of `step`, and the smallest one is `step`. */
function expectSpacing(xs: number[], step: number): void {
  const s = [...xs].sort((a, b) => a - b);
  const gaps = s.slice(1).map((v, i) => v - s[i]!);
  for (const g of gaps) expect(g / step).toBeCloseTo(Math.round(g / step), 6);
  expect(Math.min(...gaps)).toBeCloseTo(step, 6);
}

test('parallel parking strip: cars in the middle of the strip, 5.8 m apart, facing the side\'s traffic, ~70 % occupied', () => {
  const r = mk(1, 'secondary', ROAD, { lanes: '2', 'cycleway:both': 'lane', 'parking:left': 'lane' });
  const spots = parkedCarSpots(world([r]), 7, []);
  expect(spots.length).toBeGreaterThan(0);
  for (const s of spots) {
    expect(s.pos.z).toBeLessThan(0); // left side only: no kerb parking on the other side, none on the cycle lane
    expect(Math.abs(Math.abs(s.pos.z) - (sideOffsets(r.cross).left.kerb - 1.0))).toBeLessThanOrEqual(0.1); // middle of the 2 m strip
    const f = fwd(s.heading);
    expect(f.x).toBeCloseTo(-1, 6); // left side of a two-way road: traffic goes against the way
    expect(f.z).toBeCloseTo(0, 6);
  }
  expectSpacing(spots.map((s) => s.pos.x), 5.8);
  const candidates = 400 / 5.8;
  expect(spots.length / candidates).toBeGreaterThan(0.5); // 70 % minus the junction-free road ends
  expect(spots.length / candidates).toBeLessThan(0.85);
});

test('diagonal strip: cars at 45° to the kerb, 3.2 m apart, in the middle of the strip', () => {
  const r = mk(1, 'tertiary', ROAD, { 'parking:right': 'lane', 'parking:right:orientation': 'diagonal' });
  const spots = parkedCarSpots(world([r]), 7, []);
  expect(spots.length).toBeGreaterThan(0);
  for (const s of spots) {
    expect(s.pos.z).toBeCloseTo(sideOffsets(r.cross).right.kerb - r.cross.parkRight / 2, 6);
    const f = fwd(s.heading);
    expect(f.x).toBeCloseTo(Math.SQRT1_2, 6); // with the traffic, nose towards the kerb
    expect(f.z).toBeCloseTo(Math.SQRT1_2, 6);
  }
  expectSpacing(spots.map((s) => s.pos.x), 3.2);
});

test('perpendicular strip: cars at 90° to the kerb, 2.6 m apart', () => {
  const r = mk(1, 'tertiary', ROAD, { 'parking:right': 'lane', 'parking:right:orientation': 'perpendicular' });
  const spots = parkedCarSpots(world([r]), 7, []);
  expect(spots.length).toBeGreaterThan(0);
  for (const s of spots) {
    const f = fwd(s.heading);
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.z).toBeCloseTo(1, 6);
  }
  expectSpacing(spots.map((s) => s.pos.x), 2.6);
});

test('without strip tags: cars at the kerb as before, but beside the cycle lane, never on it', () => {
  const r = mk(1, 'residential', ROAD, { 'cycleway:both': 'lane' });
  const spots = parkedCarSpots(world([r]), 7, []);
  expect(spots.length).toBeGreaterThan(0);
  for (const s of spots) expect(Math.abs(s.pos.z)).toBeCloseTo(sideOffsets(r.cross).right.lane - 1.0, 6);
  // secondary roads without strips stay free
  expect(parkedCarSpots(world([mk(1, 'secondary', ROAD)]), 7, []).length).toBe(0);
});

test('no cars at junctions: clear of the crossing carriageway', () => {
  const main = mk(1, 'secondary', [[-200, 0], [0, 0], [200, 0]], { lanes: '4', 'parking:both': 'lane' });
  const cross = mk(2, 'secondary', [[0, -200], [0, 0], [0, 200]], { lanes: '6' }); // 19.5 m wide
  const spots = parkedCarSpots(world([main, cross]), 7, []);
  expect(spots.filter((s) => Math.abs(s.pos.z) < 15).length).toBeGreaterThan(0);
  for (const s of spots) {
    if (Math.abs(s.pos.z) < 15) expect(Math.abs(s.pos.x)).toBeGreaterThan(cross.width / 2 + 2.1);
  }
});

test('70 % occupancy everywhere: no thinning towards the edges of the map below the 2600 cap', () => {
  const long = mk(1, 'secondary', [[-1900, 0], [1900, 0]], { 'parking:both': 'lane' });
  const f = { ...world([long]), boundary: [{ x: -2000, z: -50 }, { x: 2000, z: -50 }, { x: 2000, z: 50 }, { x: -2000, z: 50 }] };
  const spots = parkedCarSpots(f, 7, []);
  const perHalf = (sgn: number) => spots.filter((s) => Math.sign(s.pos.x) === sgn).length / (2 * 1900 / 5.8);
  for (const sgn of [-1, 1]) {
    expect(perHalf(sgn)).toBeGreaterThan(0.62);
    expect(perHalf(sgn)).toBeLessThan(0.78);
  }
});
