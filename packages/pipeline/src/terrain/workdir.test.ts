import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { pidAlive, STALE_RUN_MS, unlinkRunFile, withRunDir } from './workdir.js';

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

const alive = () => true;
const dead = () => false;

test('at the start, run folders of a live pid go once older than a day; younger ones (a run may be live) stay', async () => {
  mkdirSync(root, { recursive: true });
  const old = join(root, '123-deadbeef'), young = join(root, '456-cafebabe');
  for (const d of [old, young]) {
    mkdirSync(d);
    writeFileSync(join(d, 't3.bin'), 'x');
  }
  const past = (Date.now() - STALE_RUN_MS - 60_000) / 1000;
  utimesSync(old, past, past);
  const recent = (Date.now() - STALE_RUN_MS + 3_600_000) / 1000;
  utimesSync(young, recent, recent);
  await withRunDir(root, async (dir) => {
    expect(readdirSync(root).sort()).toEqual([basename(young), basename(dir)].sort());
  }, { isAlive: alive });
  expect(readdirSync(root)).toEqual([basename(young)]);
  expect(STALE_RUN_MS).toBe(24 * 3600 * 1000);
});

test('at the start, a fresh run folder whose pid is dead goes at once; one of a live pid stays', async () => {
  mkdirSync(root, { recursive: true });
  const gone = join(root, '123-deadbeef'), live = join(root, '456-cafebabe');
  for (const d of [gone, live]) {
    mkdirSync(d);
    writeFileSync(join(d, 't3.bin'), 'x');
  }
  const asked: number[] = [];
  await withRunDir(root, async () => {}, { isAlive: (pid) => (asked.push(pid), pid === 456) });
  expect(readdirSync(root)).toEqual([basename(live)]);
  expect(asked.sort()).toEqual([123, 456]);
});

test('the cleanup goes by name: foreign files and folders of any name survive, also when no pid is alive', async () => {
  mkdirSync(root, { recursive: true });
  const past = (Date.now() - STALE_RUN_MS - 60_000) / 1000;
  const oldRun = join(root, '123-deadbeef'), foreignDir = join(root, 'photos'), oddRun = join(root, '12a-deadbeef'), longHex = join(root, '123-deadbeef0');
  for (const d of [oldRun, foreignDir, oddRun, longHex]) {
    mkdirSync(d);
    writeFileSync(join(d, 'x'), 'x');
    utimesSync(d, past, past);
  }
  const foreign = ['t0.bin', 't3.bin', '.t1.bin.123.abcd1234.tmp', '.t0.bin.123.abcd1234.spool', 'notes.txt', 't4.bin', 't0.bin.bak', '.hidden', '789-abcdef12'];
  for (const f of foreign) writeFileSync(join(root, f), 'x'); // ('789-abcdef12': a file named like a run folder)
  await withRunDir(root, async () => {}, { isAlive: dead });
  expect(readdirSync(root).sort()).toEqual([...foreign, 'photos', '12a-deadbeef', '123-deadbeef0'].sort());
  expect(readdirSync(foreignDir)).toEqual(['x']);
});

test('a symbolic link named like a run folder is never followed nor removed', async () => {
  mkdirSync(root, { recursive: true });
  const target = join(dirname(root), 'kept');
  mkdirSync(target);
  writeFileSync(join(target, 'x'), 'x');
  symlinkSync(target, join(root, '123-deadbeef'));
  await withRunDir(root, async () => {}, { isAlive: dead });
  expect(readdirSync(root)).toEqual(['123-deadbeef']);
  expect(readdirSync(target)).toEqual(['x']);
});

test('pidAlive: only ESRCH means dead; EPERM, the own pid and pids ≤ 1 count as alive (the last two never signalled)', () => {
  const kill = vi.spyOn(process, 'kill');
  try {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    kill.mockImplementation(fail('ESRCH'));
    expect(pidAlive(4242)).toBe(false);
    kill.mockImplementation(fail('EPERM'));
    expect(pidAlive(4242)).toBe(true);
    kill.mockImplementation(() => true);
    expect(pidAlive(4242)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 0);
    kill.mockClear();
    kill.mockImplementation(fail('ESRCH'));
    for (const pid of [process.pid, 1, 0, -1, Number.MAX_SAFE_INTEGER + 2]) expect(pidAlive(pid)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

test('unlinkRunFile removes a file directly inside a run folder and refuses anything else', async () => {
  await withRunDir(root, async (dir) => {
    const f = join(dir, 't0.bin');
    writeFileSync(f, 'x');
    const outside = join(root, 'notes.txt');
    writeFileSync(outside, 'x');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'y'), 'x');
    expect(() => unlinkRunFile(dir, outside)).toThrow(/not a file of/);
    expect(() => unlinkRunFile(dir, join(dir, '..', 'notes.txt'))).toThrow(/not a file of/);
    expect(() => unlinkRunFile(dir, join(dir, 'sub', 'y'))).toThrow(/not a file of/);
    expect(() => unlinkRunFile(root, outside)).toThrow(/not a run folder/);
    expect(() => unlinkRunFile(dir, join(dir, 'sub'))).toThrow(); // (a folder: unlink refuses it)
    unlinkRunFile(dir, f);
    expect(readdirSync(dir)).toEqual(['sub']);
    expect(readdirSync(root).sort()).toEqual([basename(dir), 'notes.txt'].sort());
  });
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
  await expect(withRunDir(root, fn, { isAlive: dead })).rejects.toThrow(/symbolic link/);
  expect(fn).not.toHaveBeenCalled();
  expect(readdirSync(target).sort()).toEqual(['123-deadbeef', 't0.bin']);
  await expect(withRunDir('', fn)).rejects.toThrow(/empty/);
});

// (skipped as root: root removes the folder despite the read-only parent)
test.skipIf(process.getuid?.() === 0)('a failing cleanup after a failed run is logged and does not hide the run\'s error', async () => {
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
