import { expect, test } from 'vitest';
import { buildPlan, planAt, planDuration, rampsForLegs } from './plan';
import type { NpcLook, Plan } from './types';

const LOOK: NpcLook = { variant: 0, tint: 0, scale: 1, vehicleType: -1, vehicleColor: 0 };
const base = { id: 1, kind: 'walker' as const, look: LOOK, startTick: 0, seq: 0, action: 'move' as const };

test('moves along a straight path at constant speed', () => {
  const p = buildPlan({ ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], speed: 2 });
  const a = planAt(p, 150);
  expect(a.x).toBeCloseTo(5, 6);
  expect(a.heading).toBeCloseTo(Math.PI / 2, 6);
  expect(a.speed).toBeCloseTo(2, 6);
  expect(a.done).toBe(false);
  const b = planAt(p, 400);
  expect(b.x).toBeCloseTo(10, 6);
  expect(b.done).toBe(true);
  expect(b.speed).toBe(0);
  expect(planDuration(p)).toBe(300);
});

test('follows corners and keeps heading continuous', () => {
  const p = buildPlan({ ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }], speed: 1.5 });
  let prev = planAt(p, 0).heading;
  for (let t = 1; t < planDuration(p); t++) {
    const h = planAt(p, t).heading;
    let d = h - prev;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    expect(Math.abs(d)).toBeLessThan(0.3);
    prev = h;
  }
  expect(planAt(p, planDuration(p) - 1).heading).toBeCloseTo(0, 1);
});

test('accelerates along a ramp', () => {
  const p = buildPlan({ ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }], speed: 2, startSpeed: 0, accel: 0.5 });
  // s = ½·a·t² while accelerating: after 2 s, 1 m
  expect(planAt(p, 120).z).toBeCloseTo(1, 3);
  expect(planAt(p, 120).speed).toBeCloseTo(1, 3);
  // full speed after 4 s (s = 4 m), then 2 m/s
  expect(planAt(p, 360).z).toBeCloseTo(8, 3);
});

test('decelerates to a stop at the end', () => {
  const p = buildPlan({ ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }], speed: 2, endSpeed: 0, accel: 1 });
  const end = planDuration(p);
  expect(planAt(p, end).z).toBeCloseTo(10, 3);
  expect(planAt(p, end - 1).speed).toBeLessThan(0.1);
});

test('holds before startTick and after the end', () => {
  const p = buildPlan({ ...base, startTick: 100, path: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 13 }], speed: 2 });
  const a = planAt(p, 50);
  expect([a.x, a.y, a.z]).toEqual([1, 2, 3]);
  expect(a.speed).toBe(0);
  const b = planAt(p, 10_000);
  expect([b.x, b.y, b.z]).toEqual([1, 2, 13]);
  expect(b.done).toBe(true);
});

test('pitch follows the slope', () => {
  const p = buildPlan({ ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 10 }], speed: 2 });
  expect(planAt(p, 60).pitch).toBeCloseTo(Math.atan2(1, 10), 3);
  expect(planAt(p, 60).y).toBeCloseTo(0.2, 2);
});

test('rampsForLegs: slows down for a slow leg in time and speeds up after it', () => {
  // 50 m at 10 m/s, 10 m at 4 m/s, 50 m at 10 m/s; accel 2 m/s²
  const ramps = rampsForLegs([{ len: 50, v: 10 }, { len: 10, v: 4 }, { len: 50, v: 10 }], 10, 10, 2);
  const p = { ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 110 }], ramps };
  let t = 0;
  while (planAt(p, t).s < 50) t++;
  expect(planAt(p, t).speed).toBeLessThanOrEqual(4.05); // at the slow leg's start
  while (planAt(p, t).s < 60) {
    expect(planAt(p, t).speed).toBeLessThanOrEqual(4.05);
    t++;
  }
  expect(planAt(p, planDuration(p) - 30).speed).toBeGreaterThan(9);
  // contiguous ramps from 0 to the end
  expect(ramps[0]!.s0).toBe(0);
  for (let i = 1; i < ramps.length; i++) {
    expect(ramps[i]!.s0).toBeCloseTo(ramps[i - 1]!.s1, 9);
    expect(ramps[i]!.v0).toBeCloseTo(ramps[i - 1]!.v1, 9);
  }
  expect(ramps[ramps.length - 1]!.s1).toBeCloseTo(110, 9);
});

test('rampsForLegs: a stop at the end of a short leg', () => {
  const ramps = rampsForLegs([{ len: 3, v: 8 }], 8, 0, 2);
  const p = { ...base, path: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }], ramps };
  expect(Number.isFinite(planDuration(p))).toBe(true);
  expect(planAt(p, planDuration(p)).z).toBeCloseTo(3, 6);
});

test('wait and sit stay at the first point', () => {
  for (const action of ['wait', 'sit'] as const) {
    const p: Plan = buildPlan({ ...base, action, path: [{ x: 4, y: 0, z: 5 }, { x: 9, y: 0, z: 5 }], speed: 0 });
    const a = planAt(p, 500);
    expect([a.x, a.z]).toEqual([4, 5]);
    expect(a.heading).toBeCloseTo(Math.PI / 2, 6);
    expect(a.speed).toBe(0);
  }
});
