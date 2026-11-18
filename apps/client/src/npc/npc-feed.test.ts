import { describe, expect, test } from 'vitest';
import { buildPlan, NPC_BLEND_S, NPC_FADE_IN_S, TICK_HZ, type Plan } from '@nn/shared';
import { predictedServerTick } from '../net/online-session';
import { ClientNpcFeed } from './npc-feed';

const look = { variant: 0, tint: 0, scale: 1, vehicleType: -1, vehicleColor: 0 };
const walk = (seq: number, startTick: number, from: number, to: number, speed = 1.5): Plan =>
  buildPlan({ id: 1, kind: 'walker', look, startTick, seq, action: 'move', path: [{ x: from, y: 0, z: 0 }, { x: to, y: 0, z: 0 }], speed });

test('predictedServerTick: the server tick after the step of input seq', () => {
  expect(predictedServerTick(1000, 50, 53)).toBe(1003);
  expect(predictedServerTick(1000, 50, 50)).toBe(1000);
});

describe('ClientNpcFeed', () => {
  test('a fresh npc fades in over NPC_FADE_IN_S', () => {
    const f = new ClientNpcFeed();
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(0, 0, 0, 30) }] }, 1000, 0);
    expect(f.draws(0, 1000)[0]!.alpha).toBe(0);
    expect(f.draws(30, 1000 + (NPC_FADE_IN_S * 1000) / 2)[0]!.alpha).toBeCloseTo(0.5, 2);
    expect(f.draws(60, 1000 + NPC_FADE_IN_S * 1000 + 1)[0]!.alpha).toBe(1);
  });

  test('holds at the end of an expired plan and blends into the next', () => {
    const f = new ClientNpcFeed();
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(0, 0, 0, 3) }] }, 0, 0); // ends after 2 s at x = 3
    expect(f.draws(150, 2500)[0]!.pose.x).toBeCloseTo(3, 6); // half a second without a plan: stands at the end
    // the next plan starts where the server had it, 0.2 m further (it kept walking a little)
    f.push({ tick: 150, msgs: [{ t: 'plan', plan: walk(1, 150, 3.2, 20) }] }, 2500, 150);
    let last = f.draws(150, 2500)[0]!.pose.x;
    expect(last).toBeCloseTo(3, 2);
    for (let ms = 2516; ms < 2900; ms += 16) {
      const x = f.draws(150 + ((ms - 2500) * TICK_HZ) / 1000, ms)[0]!.pose.x;
      expect(Math.abs(x - last)).toBeLessThan(0.08); // < 5 m/s: no visible jump
      last = x;
    }
  });

  test('a replaced plan blends over NPC_BLEND_S', () => {
    const f = new ClientNpcFeed();
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(0, 0, 0, 30) }] }, 0, 0);
    // at tick 60 (x = 1.5) the server stopped it at x = 1.2
    f.push({ tick: 60, msgs: [{ t: 'plan', plan: { ...walk(1, 60, 1.2, 1.7), action: 'wait' } }] }, 1000, 60);
    expect(f.draws(60, 1000)[0]!.pose.x).toBeCloseTo(1.5, 2);
    expect(f.draws(60, 1000 + (NPC_BLEND_S * 1000) / 2)[0]!.pose.x).toBeCloseTo(1.35, 1);
    expect(f.draws(60, 1000 + NPC_BLEND_S * 1000 + 1)[0]!.pose.x).toBeCloseTo(1.2, 6);
  });

  test('a seamless follow-up plan of a fast car does not lurch', () => {
    const f = new ClientNpcFeed();
    const car = (seq: number, start: number, from: number) => ({ ...walk(seq, start, from, from + 200, 13.9), kind: 'driver' as const });
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: car(0, 0, 0) }] }, 0, 0);
    // at tick 120 the server sends the next plan, starting exactly where the car is then (2 s × 13.9 m/s)
    const at = 120, x0 = 13.9 * 2;
    f.push({ tick: at, msgs: [{ t: 'plan', plan: car(1, at, x0) }] }, 2000, at);
    let last = f.draws(at, 2000)[0]!.pose.x;
    for (let ms = 2016; ms < 2400; ms += 16) {
      const x = f.draws(at + ((ms - 2000) * TICK_HZ) / 1000, ms)[0]!.pose.x;
      expect(Math.abs(x - last - 13.9 * 0.016)).toBeLessThan(0.03); // steady speed, no catch-up
      last = x;
    }
  });

  test('a stale plan (older seq) is ignored', () => {
    const f = new ClientNpcFeed();
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(3, 0, 0, 30) }] }, 0, 0);
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(2, 0, 50, 80) }] }, 10, 0);
    expect(f.draws(0, 2000)[0]!.pose.x).toBeCloseTo(0, 6);
  });

  test('say shows for 3 s; gone fades out and removes', () => {
    const f = new ClientNpcFeed();
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(0, 0, 0, 30) }, { t: 'say', id: 1, line: 2 }] }, 0, 0);
    expect(f.draws(0, 100)[0]!.say).toEqual({ line: 2, age: 0.1 });
    expect(f.draws(0, 3100)[0]!.say).toBeNull();
    f.push({ tick: 0, msgs: [{ t: 'gone', id: 1 }] }, 4000, 0);
    expect(f.draws(0, 4150)[0]!.alpha).toBeLessThan(1);
    expect(f.draws(0, 4400)).toEqual([]);
  });

  test('bodiesNear: npcs at the asked tick near the points, not lying ones', () => {
    const f = new ClientNpcFeed();
    f.push({ tick: 0, msgs: [{ t: 'plan', plan: walk(0, 0, 0, 30) }] }, 0, 0);
    const b = f.bodiesNear(60, [{ x: 0, z: 0 }], 10);
    expect(b.length).toBe(1);
    expect(b[0]!.x).toBeCloseTo(1.5, 6);
    expect(f.bodiesNear(60, [{ x: 100, z: 0 }], 10)).toEqual([]);
  });
});
