import { describe, expect, test } from 'vitest';
import { categoryOf, DownloadMeter, downloadSummary, formatBytes, formatEta, trackFetch } from './downloads';

describe('download categories', () => {
  test('by file name', () => {
    expect(categoryOf('/world/collision.bin')).toBe('physics');
    expect(categoryOf('/world/terrain.bin?x=1')).toBe('physics');
    expect(categoryOf('http://h/world/chunk_0_-1.glb')).toBe('city');
    expect(categoryOf('/world/model_st-marien.glb')).toBe('city');
    expect(categoryOf('/world/car_smart_lod.glb')).toBe('models');
    expect(categoryOf('/world/character_woman.glb')).toBe('models');
    expect(categoryOf('/world/map.json')).toBe('map');
    expect(categoryOf('/audio/step-1.ogg')).toBe('sound');
    expect(categoryOf('/foo.txt')).toBe('other');
  });

  test('categoryOf classifies a bucket URL by its logical name', () => {
    expect(categoryOf('https://b.example/objects/ab/ab0123.glb', () => 'chunk_0_1.glb')).toBe('city');
    expect(categoryOf('https://b.example/objects/cd/cd0123.bin', () => 'collision.bin')).toBe('physics');
    // no logical name: the URL's own file name
    expect(categoryOf('/world/map.json', () => null)).toBe('map');
  });

  test('the meter classifies through its name resolver', () => {
    const m = new DownloadMeter((url) => (url.includes('/objects/') ? 'car_smart.glb' : null));
    m.begin('https://b.example/objects/ef/ef0123.glb', 100, false);
    m.begin('/world/terrain.bin', 50, false);
    expect(m.snapshot(0).categories.map((c) => c.cat)).toEqual(['physics', 'models']);
  });
});

describe('download meter', () => {
  test('plain responses: received, total, categories', () => {
    const m = new DownloadMeter();
    const a = m.begin('/world/collision.bin', 1000, false);
    const b = m.begin('/world/chunk_0_0.glb', 500, false);
    m.data(a, 400);
    m.data(b, 500);
    m.end(b);
    const s = m.snapshot(0);
    expect(s.received).toBe(900);
    expect(s.total).toBe(1500);
    expect(s.active).toBe(1);
    expect(s.categories.map((c) => [c.cat, c.received, c.total])).toEqual([['physics', 400, 1000], ['city', 500, 500]]);
  });

  test('encoded responses: wire bytes estimated with the ratio of finished ones, exact once done', () => {
    const m = new DownloadMeter();
    const a = m.begin('/world/a.glb', 300, true);
    m.data(a, 1000);
    m.end(a); // 300 wire for 1000 decoded: ratio 0.3
    const b = m.begin('/world/b.glb', 600, true);
    m.data(b, 1000);
    expect(m.snapshot(0).received).toBeCloseTo(600, 6);
    m.data(b, 1000); // capped at its Content-Length
    expect(m.snapshot(0).received).toBe(900);
    m.end(b);
    expect(m.snapshot(0)).toMatchObject({ received: 900, total: 900, active: 0 });
  });

  test('unknown length counts what arrived; a failed download shrinks to what arrived', () => {
    const m = new DownloadMeter();
    const a = m.begin('/x', null, false);
    m.data(a, 70);
    const b = m.begin('/y', 1000, false);
    m.data(b, 100);
    m.end(b, false);
    expect(m.snapshot(0)).toMatchObject({ received: 170, total: 170, active: 1 });
  });

  test('speed over the last two seconds', () => {
    const m = new DownloadMeter();
    const a = m.begin('/x', 1e7, false);
    expect(m.snapshot(0).speed).toBeNull();
    for (let t = 250; t <= 5000; t += 250) {
      m.data(a, 250_000); // 1 MB/s
      m.snapshot(t);
    }
    expect(m.snapshot(5000).speed).toBeCloseTo(1e6, -3);
  });
});

describe('formatting', () => {
  test('bytes, eta, summary line', () => {
    expect(formatBytes(512_000)).toBe('512 kB');
    expect(formatBytes(999_800)).toBe('1,0 MB');
    expect(formatBytes(42_345_678)).toBe('42,3 MB');
    expect(formatBytes(123_456_789)).toBe('123 MB');
    expect(formatEta(12.4)).toBe('noch ca. 12 s');
    expect(formatEta(150)).toBe('noch ca. 3 min');
    expect(formatEta(Infinity)).toBe('');
    expect(downloadSummary({ received: 42_300_000, total: 97_800_000, speed: 3_400_000, active: 2, categories: [] }))
      .toBe('42,3 MB von 97,8 MB · 3,4 MB/s · noch ca. 16 s');
    expect(downloadSummary({ received: 5e6, total: 5e6, speed: null, active: 0, categories: [] })).toBe('5,0 MB von 5,0 MB');
  });
});

describe('trackFetch', () => {
  test('counts body bytes of a fetched response, leaves the response readable, restores fetch', async () => {
    const body = new Uint8Array(2048);
    const scope = { fetch: (async () => new Response(body, { headers: { 'content-length': '2048' } })) as typeof fetch };
    const original = scope.fetch;
    const m = new DownloadMeter();
    const untrack = trackFetch(m, scope);
    const res = await scope.fetch('/world/chunk_1_1.glb');
    expect((await res.arrayBuffer()).byteLength).toBe(2048);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.snapshot(0)).toMatchObject({ received: 2048, total: 2048, active: 0 });
    untrack();
    expect(scope.fetch).toBe(original);
  });
});
