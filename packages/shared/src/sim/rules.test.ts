import { expect, test } from 'vitest';
import type { TerrainGrid } from '../assets/terrain';
import { VEHICLE_REST_Y } from '../physics/vehicle';
import { CRANK_AT, DOOR_CLOSE_AT, ENGINE_CATCH_S, Ignition, type IgnitionEvent } from './ignition';
import { headingOf, parkedPose } from './rules';

/** 100×100 m grid with height = gx·x + gz·z. */
function plane(gx: number, gz: number): TerrainGrid {
  const cols = 101, rows = 101, heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = gx * c + gz * r;
  return { x0: 0, z0: 0, cols, rows, datum: 0, heights };
}

test('parkedPose on flat ground: the pure yaw quaternion', () => {
  for (const h of [0, 0.7, -2, Math.PI]) {
    const p = parkedPose(40, 50, h, plane(0, 0));
    expect(p.y).toBeCloseTo(VEHICLE_REST_Y, 6);
    expect(p.qx).toBeCloseTo(0, 12);
    expect(p.qy).toBeCloseTo(Math.sin(h / 2), 12);
    expect(p.qz).toBeCloseTo(0, 12);
    expect(p.qw).toBeCloseTo(Math.cos(h / 2), 12);
  }
});

test('parkedPose on a slope: tilt about z (rising along +x) times the yaw, heading kept', () => {
  // normal (−0.1, 1, 0)/|…|: the tilt from up is a rotation by atan(0.1) about +z
  const th = Math.atan(0.1), sz = Math.sin(th / 2), cz = Math.cos(th / 2);
  for (const h of [0, 1.2, -2.5]) {
    const sy = Math.sin(h / 2), cy = Math.cos(h / 2);
    const p = parkedPose(40, 50, h, plane(0.1, 0));
    expect(p.y).toBeCloseTo(4 + VEHICLE_REST_Y, 4);
    // (0, 0, sz, cz) · (0, sy, 0, cy)
    expect(p.qx).toBeCloseTo(-sz * sy, 6);
    expect(p.qy).toBeCloseTo(cz * sy, 6);
    expect(p.qz).toBeCloseTo(sz * cy, 6);
    expect(p.qw).toBeCloseTo(cz * cy, 6);
    expect(headingOf(p)).toBeCloseTo(h, 2);
  }
});

test('ignition in ticks: door at 21, crank at 30, running at 84', () => {
  const ig = new Ignition();
  expect(ig.state).toBe('off');
  expect(ig.lightLevel()).toBe(0);
  ig.start();
  const seen: [IgnitionEvent, number][] = [];
  const light: number[] = [];
  for (let t = 1; t <= 120; t++) {
    for (const e of ig.update()) seen.push([e, t]);
    light.push(ig.lightLevel());
  }
  expect(seen).toEqual([
    ['doorClose', Math.round(DOOR_CLOSE_AT * 60)], ['crank', Math.round(CRANK_AT * 60)], ['running', Math.round((CRANK_AT + ENGINE_CATCH_S) * 60)],
  ]);
  expect(seen.map(([, t]) => t)).toEqual([21, 30, 84]);
  expect(light[28]).toBe(0); // tick 29
  expect(light[29]).toBe(0.5); // tick 30: the starter turns
  expect(light[82]).toBe(0.5);
  expect(light[83]).toBe(1);
  expect(ig.state).toBe('running');
  ig.stop();
  expect(ig.state).toBe('off');
  expect(ig.lightLevel()).toBe(0);
  expect(ig.update()).toEqual([]);
});

test('ignition: stop while starting, restart from the beginning', () => {
  const ig = new Ignition();
  ig.start();
  for (let t = 0; t < 40; t++) ig.update();
  ig.stop();
  for (let t = 0; t < 100; t++) expect(ig.update()).toEqual([]);
  ig.start();
  expect(ig.lightLevel()).toBe(0);
  const ev: IgnitionEvent[] = [];
  for (let t = 0; t < 84; t++) ev.push(...ig.update());
  expect(ev).toEqual(['doorClose', 'crank', 'running']);
});
