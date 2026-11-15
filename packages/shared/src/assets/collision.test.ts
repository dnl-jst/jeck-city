import { expect, test } from 'vitest';
import { decodeCollision, encodeCollision, type CollisionAsset } from './collision';

const sample = (): CollisionAsset => ({
  vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10, -1.5, 3.25, 7]),
  indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
  boundary: new Float32Array([-100, -100, 100, -100, 100, 100]),
});

test('collision round trip', () => {
  const a = sample();
  expect(decodeCollision(encodeCollision(a))).toEqual(a);
});

test('decode rejects wrong magic', () => expect(() => decodeCollision(new ArrayBuffer(16))).toThrow());

test('decode rejects truncated data', () => {
  const buf = encodeCollision(sample());
  expect(() => decodeCollision(buf.slice(0, buf.byteLength - 4))).toThrow();
});

test('decode reads arrays from an unaligned slice of a larger buffer', () => {
  const buf = new Uint8Array(encodeCollision(sample()));
  const big = new Uint8Array(buf.length + 3);
  big.set(buf, 3);
  expect(decodeCollision(big.slice(3).buffer)).toEqual(sample());
});

test('vertices are quantised to 1 cm', () => {
  const a = { ...sample(), vertices: new Float32Array([0.004, 1.236, -2.5, 3, 4, 5]), indices: new Uint32Array([0, 1, 0]) };
  const d = decodeCollision(encodeCollision(a));
  expect(Array.from(d.vertices)).toEqual([0, 1.24, -2.5, 3, 4, 5].map((v) => Math.fround(v)));
});
