import { expect, it } from 'vitest';
import { checkEnvTerrain, decodeEnv, encodeEnv, type CityEnv } from './transitenv';

const TERRAIN = '0123456789abcdef0123456789abcdef';
/** Buildings west of x = 0, pavement north of z = 0, a road along z ∈ [10, 20). */
const city: CityEnv = { built: (p) => p.x < 0, pavement: (p) => p.z < 0, roadway: (p) => p.z >= 10 && p.z < 20 };
const track = [[{ x: -40, z: 0 }, { x: 40, z: 15 }]];

it('encodeEnv → decodeEnv keeps the terrain stamp and the raster along the tracks', () => {
  const { terrain, env } = decodeEnv(encodeEnv(city, track, TERRAIN));
  expect(terrain).toBe(TERRAIN);
  for (const p of [{ x: -5.2, z: -3.1 }, { x: 5.2, z: 3.1 }, { x: 20.3, z: 14.9 }, { x: 0.3, z: -0.3 }]) {
    expect([env.built(p), env.pavement(p), env.roadway(p)]).toEqual([city.built(p), city.pavement(p), city.roadway(p)]);
  }
  expect(env.built({ x: -5000, z: 0 })).toBe(false); // outside the raster nothing is known
});

it('checkEnvTerrain passes for the same terrain hash and throws for another world', () => {
  const { terrain } = decodeEnv(encodeEnv(city, track, TERRAIN));
  expect(() => checkEnvTerrain(terrain, TERRAIN)).not.toThrow();
  expect(() => checkEnvTerrain(terrain, 'f'.repeat(32))).toThrow(/built for another world .*: run the full pipeline into this folder first/);
});

it('decodeEnv rejects a truncated raster, a bad magic and a stamp that is not a hash', () => {
  const buf = encodeEnv(city, track, TERRAIN);
  expect(() => decodeEnv(buf.subarray(0, buf.byteLength - 1))).toThrow(/truncated or corrupt/);
  expect(() => decodeEnv(buf.subarray(0, 10))).toThrow(/truncated or corrupt/);
  expect(() => decodeEnv(new Uint8Array([...buf.subarray(0, 3), 0x30, ...buf.subarray(4)]))).toThrow(/truncated or corrupt/);
  expect(() => encodeEnv(city, track, 'not a hash')).toThrow(/terrain hash/);
});
