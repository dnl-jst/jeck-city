import { expect, test } from 'vitest';
import { crossSectionFromTags } from './crosssection.js';
import { buildMarkings, MARK_DY, type Piece } from './markings.js';
import type { Pt, Road } from './osm.js';
import { distToPolyline } from './polyline.js';
import type { Mesh } from './streets.js';

const mk = (id: number, kind: string, pts: [number, number][], tags: Record<string, string> = {}): Road => {
  const cross = crossSectionFromTags(tags, kind);
  return { id, kind, points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: tags.oneway === 'yes', lanes: cross.lanesForward + cross.lanesBackward, cross };
};
const Y = 0.01;
const roadY = () => Y;
const verts = (m: Mesh) => Array.from({ length: m.positions.length / 3 }, (_, i) => ({
  x: m.positions[i * 3]!, y: m.positions[i * 3 + 1]!, z: m.positions[i * 3 + 2]!, mark: m.mark![i]!,
}));
const of = (pieces: Piece[], kind: Piece['kind'], road?: number, side?: number) =>
  pieces.filter((p) => p.kind === kind && (road === undefined || p.road === road) && (side === undefined || p.side === side));

// Neusser-Straße-like main road (east-west) with a residential side street joining from the south at x = 0
const NEUSSER = { lanes: '2', 'cycleway:both': 'lane', 'parking:both': 'lane' }; // 2×2.0 + 2×1.6 + 2×3.25 = 13.7
const main = mk(1, 'secondary', [[-150, 0], [0, 0], [150, 0]], NEUSSER);
const side = mk(2, 'residential', [[0, 0], [0, 80]], { width: '8' }); // wider than the cycle lane's lateral offset + margin
const node: Pt = { x: 0, z: 0 };
const t = buildMarkings([main, side], roadY);

test('centre line: 3 m dashes, 6 m gaps → 10 dashes on 90 m', () => {
  const r = mk(3, 'secondary', [[0, 0], [90, 0]]);
  const centre = of(buildMarkings([r], roadY).pieces, 'centre');
  expect(centre.length).toBe(10);
  for (const p of centre) expect(p.s1 - p.s0).toBeCloseTo(3, 6);
});

test('lane dividers dashed only with ≥ 2 lanes per direction; no centre line on a oneway', () => {
  expect(of(buildMarkings([mk(3, 'secondary', [[0, 0], [90, 0]], { lanes: '4' })], roadY).pieces, 'lane').length).toBe(20); // one per direction
  expect(of(t.pieces, 'lane').length).toBe(0);
  const one = buildMarkings([mk(4, 'secondary', [[0, 0], [90, 0]], { oneway: 'yes', lanes: '2' })], roadY).pieces;
  expect(of(one, 'centre').length).toBe(0);
  expect(of(one, 'lane').length).toBe(10);
});

test('residential streets get no centre line', () => {
  expect(of(buildMarkings([mk(3, 'residential', [[0, 0], [90, 0]])], roadY).pieces, 'centre').length).toBe(0);
});

test('all marking vertices lie on the carriageway, at road y + 0.004', () => {
  const hw = main.width / 2;
  const v = verts(t.mesh);
  expect(v.length).toBeGreaterThan(0);
  for (const p of v) {
    expect(Math.min(distToPolyline(p, main.points) - hw, distToPolyline(p, side.points) - side.width / 2)).toBeLessThanOrEqual(1e-3);
    expect(p.y).toBeCloseTo(Y + MARK_DY, 6);
  }
  expect(t.mesh.uv.length / 2).toBe(v.length);
  expect(t.mesh.mark!.length).toBe(v.length);
});

test('no white marking within 5 m of a junction node', () => {
  for (const p of verts(t.mesh)) if (p.mark === 0) expect(Math.hypot(p.x - node.x, p.z - node.z)).toBeGreaterThanOrEqual(5 - 0.02);
});

test('red cycle crossing only on the side street side of the through road, ≤ 12 m from the node', () => {
  const red = verts(t.mesh).filter((p) => p.mark === 1);
  expect(red.length).toBeGreaterThan(0);
  for (const p of red) {
    expect(Math.hypot(p.x - node.x, p.z - node.z)).toBeLessThanOrEqual(12 + 1e-3);
    expect(p.z).toBeGreaterThan(0); // the side street joins from the south (+z, right of travel)
  }
  // it covers the side street mouth (half width 3 m)
  const xs = red.map((p) => p.x);
  expect(Math.min(...xs)).toBeLessThanOrEqual(-3);
  expect(Math.max(...xs)).toBeGreaterThanOrEqual(3);
  expect(of(t.pieces, 'red', 2).length).toBe(0); // not on the side street
});

test('cycle lane boundary: solid 0.25 m line, broken only around the junction', () => {
  const right = of(t.pieces, 'cycle', 1, 1);
  expect(right.length).toBe(2); // before and after the junction
  expect(right.reduce((a, p) => a + p.s1 - p.s0, 0)).toBeGreaterThan(280);
  const zs = verts(t.mesh).filter((p) => p.mark === 0 && Math.abs(p.x) > 20 && p.z > 1).map((p) => p.z);
  // inner edge of the right cycle lane at 3.25 m: Breitstrich 3.25..3.5, thin line to the parking strip at 4.73..4.85
  expect(Math.min(...zs)).toBeCloseTo(3.25, 3);
  expect(zs.some((z) => Math.abs(z - 3.5) < 1e-3)).toBe(true);
  expect(Math.max(...zs)).toBeCloseTo(4.85, 3);
});

test('bike pictograms every 40 m on each cycle lane, none in the junction', () => {
  for (const sd of [1, -1]) {
    const s = of(t.pieces, 'bike', 1, sd).map((p) => p.s0).sort((a, b) => a - b);
    expect(s.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < s.length; i++) {
      const d = s[i]! - s[i - 1]!; // 40 m, or a multiple where the junction swallowed one
      expect(d).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(d / 40).toBeCloseTo(Math.round(d / 40), 6);
    }
    expect(s.filter((v, i) => i > 0 && Math.abs(v - s[i - 1]! - 40) < 1e-6).length).toBeGreaterThanOrEqual(4);
    for (const p of of(t.pieces, 'bike', 1, sd)) expect(Math.abs(p.x - node.x)).toBeGreaterThan(6); // clear of the red crossing (|x| ≤ ~4.5)
  }
});

test('a side street\'s markings stop at the through road\'s carriageway edge', () => {
  const wide = mk(1, 'secondary', [[-150, 0], [0, 0], [150, 0]], { ...NEUSSER, lanes: '4' }); // kerbs at ±10.1
  const s2 = mk(2, 'secondary', [[0, 0], [0, 80]]);
  const m = buildMarkings([wide, s2], roadY);
  const centre = of(m.pieces, 'centre', 2);
  expect(centre.length).toBeGreaterThan(0);
  const hw = wide.width / 2;
  for (const p of centre) expect(Math.min(p.s0, p.s1)).toBeGreaterThanOrEqual(hw + 0.2 - 1e-6);
});

test('with ≥ 2 lanes per direction the centre is a solid double line (2 × 0.12 m, 0.12 m apart), not dashed', () => {
  const m = buildMarkings([mk(3, 'secondary', [[0, 0], [90, 0]], { lanes: '4' })], roadY);
  const centre = of(m.pieces, 'centre');
  expect(centre.length).toBe(2);
  for (const p of centre) expect(p.s1 - p.s0).toBeGreaterThan(85);
  expect(centre.map((p) => p.z).sort((a, b) => a - b).map((z) => +z.toFixed(3))).toEqual([-0.12, 0.12]);
  // nothing white between the two lines
  const zs = verts(m.mesh).filter((p) => p.mark === 0 && Math.abs(p.z) < 1).map((p) => Math.abs(p.z));
  expect(Math.min(...zs)).toBeCloseTo(0.06, 6);
  expect(Math.max(...zs)).toBeCloseTo(0.18, 6);
  // one lane per direction keeps the dashed centre line
  expect(of(buildMarkings([mk(3, 'secondary', [[0, 0], [90, 0]])], roadY).pieces, 'centre').length).toBe(10);
});

test('bike pictograms face the travel direction of their lane; only opposite_lane runs against a oneway', () => {
  const bikes = (tags: Record<string, string>) => of(buildMarkings([mk(5, 'secondary', [[0, 0], [200, 0]], tags)], roadY).pieces, 'bike');
  const travel = (pieces: Piece[], side: number) => [...new Set(pieces.filter((p) => p.side === side).map((p) => p.travel))];
  const two = bikes({ 'cycleway:both': 'lane' });
  expect(travel(two, 1)).toEqual([1]);
  expect(travel(two, -1)).toEqual([-1]);
  expect(travel(bikes({ oneway: 'yes', 'cycleway:left': 'lane' }), -1)).toEqual([1]);
  expect(travel(bikes({ oneway: 'yes', 'cycleway:left': 'opposite_lane' }), -1)).toEqual([-1]);
  expect(travel(bikes({ oneway: 'yes', cycleway: 'opposite_lane' }), -1)).toEqual([-1]);
  expect(travel(bikes({ oneway: 'yes', 'cycleway:right': 'lane' }), 1)).toEqual([1]);
});
