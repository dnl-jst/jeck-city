import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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

test('the cleanup goes by name: foreign files and foreign old folders under root survive; matching run folders and the old flat files go', async () => {
  mkdirSync(root, { recursive: true });
  const past = (Date.now() - STALE_RUN_MS - 60_000) / 1000;
  const oldRun = join(root, '123-deadbeef'), foreignDir = join(root, 'photos'), oddRun = join(root, '12a-deadbeef');
  for (const d of [oldRun, foreignDir, oddRun]) {
    mkdirSync(d);
    writeFileSync(join(d, 'x'), 'x');
    utimesSync(d, past, past);
  }
  const flat = ['t0.bin', 't3.bin', '.t1.bin.123.abcd1234.tmp', '.t0.bin.123.abcd1234.spool'];
  const foreign = ['notes.txt', 't4.bin', 't0.bin.bak', '.hidden'];
  for (const f of [...flat, ...foreign]) writeFileSync(join(root, f), 'x');
  await withRunDir(root, async () => {});
  expect(readdirSync(root).sort()).toEqual([...foreign, 'photos', '12a-deadbeef'].sort());
  expect(readdirSync(foreignDir)).toEqual(['x']);
});

test('a symlinked root (or an empty one) is refused before anything is deleted', async () => {
  const target = join(dirname(root), 'elsewhere');
  mkdirSync(target);
  const past = (Date.now() - STALE_RUN_MS - 60_000) / 1000;
  mkdirSync(join(target, '123-deadbeef'));
  utimesSync(join(target, '123-deadbeef'), past, past);
  writeFileSync(join(target, 't0.bin'), 'x');
  symlinkSync(target, root);
  const fn = vi.fn(async () => {});
  await expect(withRunDir(root, fn)).rejects.toThrow(/symbolic link/);
  expect(fn).not.toHaveBeenCalled();
  expect(readdirSync(target).sort()).toEqual(['123-deadbeef', 't0.bin']);
  await expect(withRunDir('', fn)).rejects.toThrow(/empty/);
});

test('a failing cleanup after a failed run is logged and does not hide the run\'s error', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(withRunDir(root, async () => {
      chmodSync(root, 0o555); // the run folder can no longer be removed from root
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]![0])).toMatch(/could not remove/);
  } finally {
    chmodSync(root, 0o755);
    err.mockRestore();
  }
});
