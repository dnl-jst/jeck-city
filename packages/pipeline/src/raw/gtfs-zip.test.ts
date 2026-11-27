import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readZipText, unpackGtfs, zipEntryNames } from './gtfs-zip';
import { GTFS_FIXTURE, makeZip } from './zipfixture';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nn-gtfszip-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('unpackGtfs unpacks only the six tables into <root>/<hash>/, once, and drops other feeds', async () => {
  const zip = join(dir, 'gtfs.zip');
  await writeFile(zip, makeZip({ ...GTFS_FIXTURE, 'shapes.txt': 'shape_id\n', 'agency.txt': 'agency_id\n' }));
  const root = join(dir, 'cache');
  await mkdir(join(root, 'oldfeed'), { recursive: true });
  const out = await unpackGtfs(zip, 'abc', root);
  expect(out).toBe(join(root, 'abc'));
  expect((await readdir(out)).sort()).toEqual(Object.keys(GTFS_FIXTURE).sort());
  expect(await readFile(join(out, 'stop_times.txt'), 'utf8')).toBe(GTFS_FIXTURE['stop_times.txt']);
  expect(await readdir(root)).toEqual(['abc']);
  // a second call finds the folder and does not open the zip
  await rm(zip);
  expect(await unpackGtfs(zip, 'abc', root)).toBe(out);
});

it('unpackGtfs rejects a feed that lacks a table and leaves no folder behind', async () => {
  const zip = join(dir, 'gtfs.zip');
  const { 'stop_times.txt': _, ...rest } = GTFS_FIXTURE;
  await writeFile(zip, makeZip(rest));
  const root = join(dir, 'cache');
  await expect(unpackGtfs(zip, 'abc', root)).rejects.toThrow(/stop_times\.txt/);
  expect(await readdir(root)).toEqual([]);
});

it('readZipText reads one entry, null when the zip lacks it; zipEntryNames lists them all', async () => {
  const zip = join(dir, 'gtfs.zip');
  await writeFile(zip, makeZip({ 'calendar.txt': 'a,b\n', 'docs/Lizenz.txt': 'dl-de/zero-2.0' }));
  expect(await readZipText(zip, 'calendar.txt')).toBe('a,b\n');
  expect(await readZipText(zip, 'routes.txt')).toBeNull();
  expect(await zipEntryNames(zip)).toEqual(['calendar.txt', 'docs/Lizenz.txt']);
});
