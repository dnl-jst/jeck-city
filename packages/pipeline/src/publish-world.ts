import { resolve } from 'node:path';
import { publishWorld } from './publish/publish.js';
import { s3Store } from './publish/s3.js';

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** `npm run world:publish [-- worldDir]`: uploads the world (default apps/client/public/world) to the S3 bucket from S3_*. */
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const dir = process.argv[2] ?? 'apps/client/public/world';
  const r = await publishWorld(dir, s3Store(process.env), (line) => console.log(line));
  console.log(`uploaded ${r.uploaded} new objects (${mb(r.uploadedBytes)} as stored), ${r.present} already present`);
  console.log(`published world ${r.worldHash} (worlds/${r.worldHash}.json)`);
}
