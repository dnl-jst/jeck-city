import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { STALE_RUN_MS, withRunDir } from './workdir.js';

let root: string;
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'nn-workdir-')), 'terrain'); // (not there yet: created on demand)
});
afterEach(() => {
  rmSync(dirname(root), { recursive: true, force: true });
});

test('each run works in a folder of its own under the root, removed when the run ends', async () => {
  let seen = '';
  const out = await withRunDir(root, async (dir) => {
    seen = dir;
    expect(dirname(dir)).toBe(root);
    expect(basename(dir)).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}$`));
    writeFileSync(join(dir, 't0.bin'), 'x');
    return 42;
  });
  expect(out).toBe(42);
  expect(existsSync(seen)).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});

test('two concurrent runs get different folders and do not remove each other\'s files', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = '';
  const a = withRunDir(root, async (dir) => {
    first = dir;
    writeFileSync(join(dir, 't0.bin'), 'a');
    await held;
    expect(readdirSync(dir)).toEqual(['t0.bin']); // the second run started and ended meanwhile
  });
  await new Promise((r) => setTimeout(r, 10));
  await withRunDir(root, async (dir) => {
    expect(dir).not.toBe(first);
    expect(existsSync(join(first, 't0.bin'))).toBe(true);
    writeFileSync(join(dir, 't0.bin'), 'b');
  });
  release();
  await a;
  expect(readdirSync(root)).toEqual([]);
});

test('the folder is removed when the run fails too', async () => {
  let seen = '';
  await expect(withRunDir(root, async (dir) => {
    seen = dir;
    writeFileSync(join(dir, 't1.bin'), 'x');
    throw new Error('boom');
  })).rejects.toThrow('boom');
  expect(existsSync(seen)).toBe(false);
});

test('at the start, leftover run folders older than a day go; younger ones (a run may be live) stay; files of the old flat layout go', async () => {
  mkdirSync(root, { recursive: true });
  const old = join(root, '123-deadbeef'), young = join(root, '456-cafebabe');
  for (const d of [old, young]) {
    mkdirSync(d);
    writeFileSync(join(d, 't3.bin'), 'x');
  }
  writeFileSync(join(root, 't0.bin'), 'flat'); // what runs before per-run folders left
  const past = (Date.now() - STALE_RUN_MS - 60_000) / 1000;
  utimesSync(old, past, past);
  const recent = (Date.now() - STALE_RUN_MS + 3_600_000) / 1000;
  utimesSync(young, recent, recent);
  await withRunDir(root, async (dir) => {
    expect(readdirSync(root).sort()).toEqual([basename(young), basename(dir)].sort());
  });
  expect(readdirSync(root)).toEqual([basename(young)]);
  expect(STALE_RUN_MS).toBe(24 * 3600 * 1000);
});
