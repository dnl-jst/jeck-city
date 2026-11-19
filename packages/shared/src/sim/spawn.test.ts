import { expect, test } from 'vitest';
import { heightAt } from '../assets/terrain';
import { createPhysicsWorld } from '../physics/world';
import { SPAWN_MAX_DIST, SPAWN_STEP } from '../net/constants';
import { fixtureAssets, haveRealAssets, realAssets, WHOLE_CITY_TIMEOUT } from './fixture.test-util';
import { findSpawn, spawnCandidates, standY } from './spawn';

test('candidates: the spawn, then alternately ±k·1.5 m across the spawn heading (side by side), up to 60 m', () => {
  const c = spawnCandidates({ x: 10, y: 0, z: 20, heading: Math.PI / 2 }); // facing +x: the row runs along z
  expect(c.length).toBe(1 + 2 * Math.floor(SPAWN_MAX_DIST / SPAWN_STEP));
  expect(c[0]).toEqual({ x: 10, z: 20 });
  expect(c[1]!.z).toBeCloseTo(18.5); // left of +x is -z
  expect(c[2]!.z).toBeCloseTo(21.5);
  expect(c[3]!.z).toBeCloseTo(17);
  expect(c[1]!.x).toBeCloseTo(10);
  expect(Math.abs(c.at(-1)!.z - 20)).toBeCloseTo(SPAWN_MAX_DIST);
});

test('findSpawn skips occupied spots and spots inside obstacles', async () => {
  const a = fixtureAssets();
  // a tree right on the second candidate (1.5, 0): facing +z, the row runs along x
  a.manifest.trees = [[1.5, 0]];
  const pw = await createPhysicsWorld(a.collision, a.terrain);
  const { StreetProps } = await import('../physics/props');
  new StreetProps(pw, a.manifest.lamps, a.manifest.trees, a.terrain);
  pw.step();
  expect(findSpawn(pw, a.manifest, a.terrain, () => false)).toEqual({ x: 0, y: 0, z: 0 });
  const p = findSpawn(pw, a.manifest, a.terrain, (x, z) => x === 0 && z === 0);
  expect(p.x).toBeCloseTo(-1.5); // (1.5, 0) holds the tree
  // everything taken: the manifest spawn
  expect(findSpawn(pw, a.manifest, a.terrain, () => true)).toEqual({ x: 0, y: 0, z: 0 });
});

test.skipIf(!haveRealAssets)(
  haveRealAssets
    ? 'real manifest: candidates run along the sidewalk; 30 spawns in a row all land on it, apart and within 60 m'
    : 'real spawn candidates [SKIPPED: apps/client/public/world not found — run the pipeline]',
  async () => {
    const a = await realAssets();
    const pw = await createPhysicsWorld(a.collision, a.terrain);
    const sp = a.manifest.spawn;
    const kerb = sp.y - heightAt(a.terrain, sp.x, sp.z);
    const onSidewalk = (p: { x: number; z: number }) => Math.abs(standY(pw, a.terrain, p.x, p.z) - heightAt(a.terrain, p.x, p.z) - kerb) <= 0.06;
    // the row across the heading stays on the level Domplatte near the spawn: within ±12 m all of them
    const cand = spawnCandidates(sp);
    expect(cand.slice(0, 1 + 2 * 8).every(onSidewalk)).toBe(true);
    expect(cand.filter(onSidewalk).length).toBeGreaterThan(cand.length / 2);
    // the near ones are level with the spawn (steps and stairs further out are left out by findSpawn)
    for (const p of cand.slice(0, 1 + 2 * 8)) expect(Math.abs(standY(pw, a.terrain, p.x, p.z) - sp.y)).toBeLessThanOrEqual(0.5);
    const taken: { x: number; z: number }[] = [];
    for (let n = 0; n < 30; n++) {
      const p = findSpawn(pw, a.manifest, a.terrain, (x, z) => taken.some((t) => Math.hypot(t.x - x, t.z - z) < 1));
      expect(onSidewalk(p)).toBe(true);
      expect(Math.abs(p.y - sp.y)).toBeLessThanOrEqual(0.5);
      expect(Math.hypot(p.x - sp.x, p.z - sp.z)).toBeLessThanOrEqual(SPAWN_MAX_DIST + 1e-6);
      expect(taken.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= 1.4)).toBe(true);
      taken.push(p);
    }
  },
  WHOLE_CITY_TIMEOUT,
);
