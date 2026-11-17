import { expect, test } from 'vitest';
import { NpcDirector, planAt, type NpcMsg } from '@nn/shared';
import { gridNet } from '../../../packages/shared/src/sim/npc-fixture';
import { NpcFeed } from './npc-feed';

/** A director with NPCs around (0, 0) after 10 s, and the messages of its last tick. */
function world() {
  const d = new NpcDirector(gridNet(1600), () => 0, 3);
  let msgs: NpcMsg[] = [];
  let t = 0;
  for (; t < 600; t++) msgs = d.update(t, [{ x: 0, z: 0, heading: 0 }]);
  return { d, t, msgs };
}

test('a client entering an area receives current plans at once', () => {
  const { d, t } = world();
  const feed = new NpcFeed();
  const b = feed.collect(d, t, { x: 0, z: 0 }, [])!;
  const plans = b.msgs.filter((m) => m.t === 'plan');
  const near = [...d.all()].filter((n) => { const p = planAt(n.plan, t); return Math.hypot(p.x, p.z) <= 250; });
  expect(plans.length).toBeGreaterThanOrEqual(near.length - 3); // the cache may lag a few new ones by a tick
  for (const m of plans) if (m.t === 'plan') expect(m.plan).toBe(d.get(m.plan.id)!.plan);
  // nothing new the next time
  expect(feed.collect(d, t, { x: 0, z: 0 }, [])).toBeNull();
});

test('gone when an npc leaves 270 m, and a client far away gets nothing', () => {
  const { d, t } = world();
  const feed = new NpcFeed();
  feed.collect(d, t, { x: 0, z: 0 }, []);
  const b = feed.collect(d, t, { x: 700, z: 700 }, []); // the client teleported
  expect(b!.msgs.every((m) => m.t === 'gone')).toBe(true);
  expect(b!.msgs.length).toBeGreaterThan(0);
  expect(new NpcFeed().collect(d, t, { x: 700, z: 700 }, [])).toBeNull();
});

test('say, honk and replaced plans only for npcs the client knows', () => {
  const { d, t } = world();
  const feed = new NpcFeed();
  feed.collect(d, t, { x: 0, z: 0 }, []);
  const known = [...d.all()].find((n) => { const p = planAt(n.plan, t); return Math.hypot(p.x, p.z) < 200; })!;
  const msgs: NpcMsg[] = [{ t: 'say', id: known.id, line: 0 }, { t: 'say', id: 999999, line: 0 }, { t: 'honk', id: known.id }, { t: 'plan', plan: known.plan }];
  const b = feed.collect(d, t, { x: 0, z: 0 }, msgs)!;
  expect(b.msgs).toEqual([{ t: 'say', id: known.id, line: 0 }, { t: 'honk', id: known.id }, { t: 'plan', plan: known.plan }]);
});
