import { expect, test } from 'vitest';
import { crossSectionFromTags } from './crosssection.js';
import { parseOsm } from './osm.js';

test('Neusser-Straße-like tags: 2 lanes, cycle lanes both sides, parallel parking left → 11.7 m', () => {
  const c = crossSectionFromTags({ lanes: '2', 'cycleway:both': 'lane', 'parking:left': 'lane', 'parking:left:orientation': 'parallel' }, 'secondary');
  expect(c).toMatchObject({
    lanesForward: 1, lanesBackward: 1, laneWidth: 3.25, cycleLeft: 1.6, cycleRight: 1.6,
    parkLeft: 2, parkRight: 0, parkLeftOrientation: 'parallel', parkRightOrientation: null,
  });
  expect(c.carriageway).toBeCloseTo(2 * 3.25 + 2 * 1.6 + 2.0, 6);
});

test('cycle tracks, separate ways and "no" put nothing on the carriageway', () => {
  for (const v of ['track', 'separate', 'no']) {
    const c = crossSectionFromTags({ lanes: '2', cycleway: v }, 'secondary');
    expect(c.cycleLeft + c.cycleRight).toBe(0);
    expect(c.carriageway).toBeCloseTo(6.5, 6);
  }
  const mixed = crossSectionFromTags({ 'cycleway:left': 'track', 'cycleway:right': 'lane' }, 'tertiary');
  expect([mixed.cycleLeft, mixed.cycleRight]).toEqual([0, 1.6]);
});

test('cycleway:*:lane alone marks a lane; opposite_lane lies against a oneway (left)', () => {
  expect(crossSectionFromTags({ 'cycleway:right:lane': 'advisory' }, 'secondary').cycleRight).toBe(1.6);
  const c = crossSectionFromTags({ oneway: 'yes', cycleway: 'opposite_lane' }, 'residential');
  expect([c.cycleLeft, c.cycleRight]).toEqual([1.6, 0]);
  expect(c.lanesForward + c.lanesBackward).toBe(1);
  expect(c.carriageway).toBeCloseTo(3.0 + 1.6, 6);
});

test('legacy parking:lane:both=diagonal → 4.5 m each side', () => {
  const c = crossSectionFromTags({ 'parking:lane:both': 'diagonal' }, 'residential');
  expect([c.parkLeft, c.parkRight]).toEqual([4.5, 4.5]);
  expect(c.parkLeftOrientation).toBe('diagonal');
  expect(c.carriageway).toBeCloseTo(2 * 3.0 + 9, 6);
});

test('parking values: on_kerb/separate/no → 0, half_on_kerb → 1.0, perpendicular → 5.0', () => {
  for (const v of ['on_kerb', 'separate', 'no']) expect(crossSectionFromTags({ 'parking:both': v }, 'residential').parkLeft).toBe(0);
  expect(crossSectionFromTags({ 'parking:right': 'half_on_kerb' }, 'residential').parkRight).toBe(1.0);
  const p = crossSectionFromTags({ 'parking:right': 'street_side', 'parking:right:orientation': 'perpendicular' }, 'residential');
  expect([p.parkRight, p.parkRightOrientation]).toEqual([5.0, 'perpendicular']);
});

test('lane counts: lanes:forward/backward, lanes, default 2 (oneway 1); residential lanes are 3.0 m', () => {
  expect(crossSectionFromTags({ lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }, 'secondary')).toMatchObject({ lanesForward: 2, lanesBackward: 1 });
  expect(crossSectionFromTags({}, 'residential')).toMatchObject({ lanesForward: 1, lanesBackward: 1, laneWidth: 3.0, carriageway: 6.0 });
  expect(crossSectionFromTags({ oneway: 'yes' }, 'primary')).toMatchObject({ lanesForward: 1, lanesBackward: 0, carriageway: 3.25 });
});

test('width=14 scales all components proportionally', () => {
  const c = crossSectionFromTags({ width: '14', lanes: '2', 'cycleway:both': 'lane', 'parking:left': 'lane' }, 'secondary');
  const k = 14 / 11.7;
  expect(c.carriageway).toBeCloseTo(14, 6);
  expect(c.laneWidth).toBeCloseTo(3.25 * k, 6);
  expect(c.cycleLeft).toBeCloseTo(1.6 * k, 6);
  expect(c.parkLeft).toBeCloseTo(2 * k, 6);
});

test('a width narrower than the components squeezes cycle/parking first, never below the lanes', () => {
  const c = crossSectionFromTags({ width: '8', lanes: '2', 'cycleway:both': 'lane' }, 'secondary');
  expect(c.carriageway).toBeCloseTo(8, 6);
  expect(c.laneWidth).toBe(3.25);
  expect(c.cycleLeft).toBeCloseTo(0.75, 6);
  expect(crossSectionFromTags({ width: '4', lanes: '2' }, 'secondary').carriageway).toBeCloseTo(6.5, 6);
});

test('paths and service roads keep their class width', () => {
  expect(crossSectionFromTags({}, 'footway').carriageway).toBe(2.5);
  expect(crossSectionFromTags({}, 'service').carriageway).toBe(4);
  expect(crossSectionFromTags({ width: '1.5' }, 'footway').carriageway).toBe(1.5);
});

test('parseOsm: Road.cross and width = carriageway; oneway=-1 flips left/right with the points', () => {
  const geometry = [{ lat: 50.96, lon: 6.95 }, { lat: 50.961, lon: 6.95 }];
  const road = (tags: Record<string, string>) => parseOsm({ elements: [{ type: 'way', id: 1, tags: { highway: 'secondary', ...tags }, geometry }] }).roads[0]!;
  const r = road({ lanes: '2', 'cycleway:both': 'lane', 'parking:left': 'lane' });
  expect(r.width).toBeCloseTo(11.7, 6);
  expect(r.cross.carriageway).toBe(r.width);
  expect(r.lanes).toBe(2);
  const rev = road({ oneway: '-1', 'parking:left': 'lane' });
  expect(rev.oneway).toBe(true);
  expect(rev.points[0]!.z).toBeLessThan(rev.points[1]!.z); // reversed: now runs south (+z)
  expect(rev.cross).toMatchObject({ lanesForward: 1, lanesBackward: 0, parkLeft: 0, parkRight: 2 });
});
