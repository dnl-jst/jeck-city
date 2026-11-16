import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticHandler } from './static';

let root: string;
let server: Server;
let port: number;

/** Raw request: fetch() would normalise '../' away before it reaches the server. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const parent = mkdtempSync(join(tmpdir(), 'nn-static-'));
  root = join(parent, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'world'));
  writeFileSync(join(root, 'index.html'), '<h1>nippes</h1>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(root, 'world', 'manifest.json'), '{}');
  writeFileSync(join(root, 'world', 'manifest.json.br'), 'BR');
  writeFileSync(join(root, 'world', 'manifest.json.gz'), 'GZ');
  writeFileSync(join(parent, 'secret.txt'), 'secret');
  const handler = staticHandler(root);
  server = createServer((req, res) => handler(req, res, () => { res.writeHead(405); res.end(); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('static hosting', () => {
  it('index.html is no-cache, also for /', async () => {
    for (const p of ['/', '/index.html']) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toBe('<h1>nippes</h1>');
    }
  });

  it('hashed assets are immutable, the world always revalidates', async () => {
    expect((await get('/assets/app-abc123.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/world/manifest.json')).headers['cache-control']).toBe('no-cache');
  });

  it('ETag on every file; If-None-Match with it is a 304 without a body', async () => {
    for (const p of ['/', '/assets/app-abc123.js', '/world/manifest.json']) {
      const r = await get(p);
      const tag = r.headers.etag as string;
      expect(tag, p).toMatch(/^"[0-9a-z]+-[0-9a-z]+(-br|-gzip)?"$/);
      const again = await get(p, { 'If-None-Match': `"other", ${tag}` });
      expect(again.status, p).toBe(304);
      expect(again.body).toBe('');
      expect(again.headers.etag).toBe(tag);
      expect(again.headers['cache-control']).toBe(r.headers['cache-control']);
      expect((await get(p, { 'If-None-Match': '"stale"' })).status, p).toBe(200);
    }
    // the compressed variant has its own tag
    const br = await get('/world/manifest.json', { 'Accept-Encoding': 'br' });
    expect(br.headers.etag).not.toBe((await get('/world/manifest.json')).headers.etag);
    expect((await get('/world/manifest.json', { 'Accept-Encoding': 'br', 'If-None-Match': `W/${br.headers.etag as string}` })).status).toBe(304);
  });

  it('serves a pre-compressed file by Accept-Encoding', async () => {
    const br = await get('/world/manifest.json', { 'Accept-Encoding': 'gzip, br' });
    expect(br.body).toBe('BR');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['content-type']).toBe('application/json');
    const gz = await get('/world/manifest.json', { 'Accept-Encoding': 'gzip' });
    expect(gz.body).toBe('GZ');
    expect(gz.headers['content-encoding']).toBe('gzip');
    const plain = await get('/world/manifest.json');
    expect(plain.body).toBe('{}');
    expect(plain.headers['content-encoding']).toBeUndefined();
  });

  it('paths outside dist and unknown files are 404', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/world/../../secret.txt', '/..%2fsecret.txt', '/nope.js', '/world', '/%00', '/%zz']) {
      expect((await get(p)).status, p).toBe(404);
    }
  });
});
