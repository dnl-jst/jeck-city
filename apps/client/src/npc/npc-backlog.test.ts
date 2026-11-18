import { expect, test } from 'vitest';
import { buildPlan, type NpcBatch, type Plan } from '@nn/shared';
import { NpcBacklog } from './npc-backlog';

const look = { variant: 0, tint: 0, scale: 1, vehicleType: -1, vehicleColor: 0 };
const plan = (id: number, seq: number): Plan =>
  buildPlan({ id, kind: 'sitter', look, startTick: 0, seq, action: 'sit', path: [{ x: id, y: 0, z: 0 }, { x: id, y: 0, z: 1 }], speed: 0 });

test('keeps the newest plan of every npc however many batches arrive before anyone listens', () => {
  const b = new NpcBacklog();
  // the first batch: every NPC in the area (sitters too, which never get another plan)
  b.add({ tick: 1, msgs: Array.from({ length: 50 }, (_, i) => ({ t: 'plan' as const, plan: plan(i, 0) })) });
  for (let t = 2; t < 500; t++) b.add({ tick: t, msgs: [{ t: 'plan', plan: plan(7, t) }, { t: 'say', id: 3, line: 1 }] });
  b.add({ tick: 600, msgs: [{ t: 'gone', id: 9 }] });
  const out: NpcBatch = b.drain()!;
  expect(out.tick).toBe(600);
  const plans = out.msgs.filter((m) => m.t === 'plan');
  expect(plans.length).toBe(49);
  expect(plans.find((m) => m.t === 'plan' && m.plan.id === 7)).toEqual({ t: 'plan', plan: plan(7, 499) });
  expect(out.msgs.some((m) => m.t !== 'plan')).toBe(false); // old lines and horns are over by now
  expect(b.drain()).toBeNull();
});
