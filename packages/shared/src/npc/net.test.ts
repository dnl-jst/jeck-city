import { expect, test } from 'vitest';
import { decodeNpcBatch, encodeNpcBatch, type NpcBatch } from './net';
import { buildPlan } from './plan';
import type { Plan } from './types';

const look = { variant: 1, tint: 0x3366aa, scale: 1.03, vehicleType: 2, vehicleColor: 0xc0262d };

function walkerPlan(points: number, spanM: number): Plan {
  const path = Array.from({ length: points }, (_, i) => ({ x: 1234.567 + (i * spanM) / (points - 1), y: 41.23 + i * 0.1, z: -876.543 + (i % 2) * 3 }));
  return buildPlan({ id: 4242, kind: 'driver', look, startTick: 123456, seq: 7, action: 'move', path, speed: 13.9, startSpeed: 0, endSpeed: 4.2 });
}

test('round-trips every message kind', () => {
  const plan = walkerPlan(12, 300);
  const b: NpcBatch = { tick: 99999, msgs: [{ t: 'plan', plan }, { t: 'gone', id: 17 }, { t: 'say', id: 4242, line: 3 }, { t: 'honk', id: 4242 }] };
  const d = decodeNpcBatch(encodeNpcBatch(b))!;
  expect(d.tick).toBe(99999);
  expect(d.msgs.slice(1)).toEqual(b.msgs.slice(1));
  const m = d.msgs[0]!;
  if (m.t !== 'plan') throw new Error('plan expected');
  const p = m.plan;
  expect([p.id, p.kind, p.startTick, p.seq, p.action]).toEqual([4242, 'driver', 123456, 7, 'move']);
  expect(p.look.variant).toBe(1);
  expect(p.look.tint).toBe(0x3366aa);
  expect(p.look.vehicleType).toBe(2);
  expect(p.look.vehicleColor).toBe(0xc0262d);
  expect(p.look.scale).toBeCloseTo(1.03, 2);
  expect(p.path.length).toBe(12);
  p.path.forEach((q, i) => {
    expect(Math.abs(q.x - plan.path[i]!.x)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(q.y - plan.path[i]!.y)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(q.z - plan.path[i]!.z)).toBeLessThanOrEqual(0.011);
  });
  expect(p.ramps.length).toBe(plan.ramps.length);
  p.ramps.forEach((r, i) => {
    const o = plan.ramps[i]!;
    expect(Math.abs(r.s0 - o.s0)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(r.s1 - o.s1)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(r.v0 - o.v0)).toBeLessThanOrEqual(0.011);
    expect(Math.abs(r.v1 - o.v1)).toBeLessThanOrEqual(0.011);
  });
});

test('rejects truncated or garbage input', () => {
  const bytes = encodeNpcBatch({ tick: 5, msgs: [{ t: 'plan', plan: walkerPlan(6, 40) }] });
  for (let n = 0; n < bytes.length; n++) expect(decodeNpcBatch(bytes.slice(0, n))).toBeNull();
  expect(decodeNpcBatch(new Uint8Array([255, 1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
});

test('plan sizes stay small', () => {
  const HEAD = encodeNpcBatch({ tick: 0, msgs: [] }).length;
  const sitter = buildPlan({ id: 1, kind: 'sitter', look, startTick: 1, seq: 0, action: 'sit', path: [{ x: 10, y: 1, z: 20 }, { x: 10.5, y: 1, z: 20 }], speed: 0 });
  expect(encodeNpcBatch({ tick: 0, msgs: [{ t: 'plan', plan: sitter }] }).length - HEAD).toBeLessThanOrEqual(40);
  const path = Array.from({ length: 6 }, (_, i) => ({ x: 100 + i * 12, y: 40, z: 50 + (i % 2) }));
  const walker = buildPlan({ id: 2, kind: 'walker', look, startTick: 1, seq: 0, action: 'move', path, speed: 1.4 });
  expect(encodeNpcBatch({ tick: 0, msgs: [{ t: 'plan', plan: walker }] }).length - HEAD).toBeLessThanOrEqual(70);
});
