/// <reference types="node" />
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { loadWorldAssets, worldHash } from './assets';
import { haveRealAssets, readWorldFile } from './fixture.test-util';

test('worldHash: first 12 hex digits of SHA-256, without Web Crypto (plain-http LAN pages have no crypto.subtle)', async () => {
  const subtle = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    for (const s of ['', '{"version":2}', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'ä'.repeat(1000)]) {
      const bytes = new TextEncoder().encode(s);
      const h = await worldHash(bytes.buffer.slice(0));
      expect(h).toBe(createHash('sha256').update(bytes).digest('hex').slice(0, 12));
      expect(h).toMatch(/^[0-9a-f]{12}$/);
    }
  } finally {
    if (subtle) Object.defineProperty(globalThis, 'crypto', subtle);
  }
});

test.skipIf(!haveRealAssets)(
  haveRealAssets ? 'loadWorldAssets reads the world files (npc.json when the manifest lists it)' : 'loadWorldAssets [SKIPPED: apps/client/public/world not found — run the pipeline]',
  async () => {
    const read: string[] = [];
    const a = await loadWorldAssets(async (f) => (read.push(f), readWorldFile(f)));
    expect(read.sort()).toEqual(['collision.bin', 'manifest.json', ...(a.manifest.npc ? ['npc.json'] : []), 'terrain.bin']);
    if (a.manifest.npc) expect(a.npc!.walk.edges.length).toBeGreaterThan(0);
    expect(a.manifest.parked.length).toBeGreaterThan(0);
    expect(a.collision.indices.length).toBeGreaterThan(0);
    expect(a.terrain.cols * a.terrain.rows).toBe(a.terrain.heights.length);
  },
);
