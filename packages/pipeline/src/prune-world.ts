import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pruneWorlds } from './publish/prune.js';
import { s3Store } from './publish/s3.js';

/** Fetches the world hash the live server runs from its /healthz (5 s timeout). */
async function liveWorldHash(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { worldHash?: unknown };
  if (typeof body.worldHash !== 'string' || body.worldHash === '') throw new Error('no worldHash field');
  return body.worldHash;
}

/**
 * `npm run world:prune -- --live <healthz-URL> [--keep 5] [--delete]`: removes old worlds and the objects only they
 * use from the bucket. Without --delete it only lists what it would remove.
 */
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const { values } = parseArgs({
    options: { live: { type: 'string' }, keep: { type: 'string', default: '5' }, delete: { type: 'boolean', default: false } },
  });
  if (!values.live) {
    console.error('usage: npm run world:prune -- --live <healthz-URL> [--keep 5] [--delete]');
    process.exit(1);
  }
  const keep = Number(values.keep);
  if (!Number.isInteger(keep) || keep < 0) {
    console.error(`--keep must be a whole number ≥ 0, got ${values.keep}`);
    process.exit(1);
  }
  let liveHash: string;
  try {
    liveHash = await liveWorldHash(values.live);
  } catch (e) {
    console.error(`cannot read the live world from ${values.live}: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log('Do not run this while a world:publish is in progress.');
  const r = await pruneWorlds(s3Store(process.env), { liveHash, keep, delete: values.delete });
  console.log(`live world: ${liveHash}`);
  console.log(`kept worlds (${r.keptWorlds.length}): ${r.keptWorlds.join(' ')}`);
  console.log(`removed worlds (${r.removedWorlds.length}): ${r.removedWorlds.join(' ')}`);
  console.log(`removed objects: ${r.removedObjects.length}`);
  for (const key of r.removedObjects) console.log(`  ${key}`);
  console.log(`kept, younger than 24 h (a publish may still be running): ${r.skippedRecent.length}`);
  for (const key of r.skippedRecent) console.log(`  ${key}`);
  if (!values.delete) console.log('dry run: nothing deleted (pass --delete to delete)');
}
