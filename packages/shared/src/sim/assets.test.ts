/// <reference types="node" />
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { loadWorldAssets, worldHash } from './assets';
import { haveRealAssets, readWorldFile } from './fixture.test-util';

test('worldHash: first 12 hex digits of SHA-256', async () => {
  const bytes = new TextEncoder().encode('{"version":2}');
  const h = await worldHash(bytes.buffer.slice(0));
  expect(h).toBe(createHash('sha256').update(bytes).digest('hex').slice(0, 12));
  expect(h).toMatch(/^[0-9a-f]{12}$/);
});

test.skipIf(!haveRealAssets)(
  haveRealAssets ? 'loadWorldAssets reads the three world files' : 'loadWorldAssets [SKIPPED: apps/client/public/world not found — run the pipeline]',
  async () => {
    const read: string[] = [];
    const a = await loadWorldAssets(async (f) => (read.push(f), readWorldFile(f)));
    expect(read.sort()).toEqual(['collision.bin', 'manifest.json', 'terrain.bin']);
    expect(a.manifest.parked.length).toBeGreaterThan(0);
    expect(a.collision.indices.length).toBeGreaterThan(0);
    expect(a.terrain.cols * a.terrain.rows).toBe(a.terrain.heights.length);
  },
);
