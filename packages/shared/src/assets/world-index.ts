/**
 * World index (index.json): maps each logical world file name to the content hash of its uncompressed bytes.
 * The pipeline writes it, the publish script uploads objects under `objectKey`, server and client read it.
 */
export type WorldIndex = { version: 1; files: Record<string, { hash: string; bytes: number }> };

export const WORLD_INDEX_FILE = 'index.json';

/** Files the server loads from the world directory. */
export const SERVER_WORLD_FILES = [
  'index.json',
  'manifest.json',
  'collision.bin',
  'terrain.bin',
  'transit-collision.bin',
] as const;

const HASH_RE = /^[0-9a-f]{32}$/;

/** Validates the parsed JSON of an index.json; throws on a wrong shape. */
export function parseWorldIndex(json: unknown): WorldIndex {
  if (typeof json !== 'object' || json === null) throw new Error('world index: not an object');
  const o = json as Record<string, unknown>;
  if (o.version !== 1) throw new Error(`world index: unsupported version ${String(o.version)}`);
  if (typeof o.files !== 'object' || o.files === null || Array.isArray(o.files)) {
    throw new Error('world index: files missing');
  }
  const files: WorldIndex['files'] = {};
  for (const [name, entry] of Object.entries(o.files)) {
    if (typeof entry !== 'object' || entry === null) throw new Error(`world index: ${name}: not an object`);
    const { hash, bytes } = entry as Record<string, unknown>;
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new Error(`world index: ${name}: invalid hash`);
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
      throw new Error(`world index: ${name}: invalid bytes`);
    }
    files[name] = { hash, bytes };
  }
  return { version: 1, files };
}

/** Bucket key of a file: objects/<first two hash chars>/<hash><extension of the name>. */
export function objectKey(name: string, hash: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  return `objects/${hash.slice(0, 2)}/${hash}${ext}`;
}

/** Bucket key of a published world: worlds/<worldHash>.json. */
export function worldObjectKey(worldHash: string): string {
  return `worlds/${worldHash}.json`;
}

/** URL of a world file: from the bucket when `worldUrl` is set, otherwise `/world/<name>`. */
export function worldFileUrl(index: WorldIndex, worldUrl: string | null, name: string): string {
  const entry = Object.hasOwn(index.files, name) ? index.files[name] : undefined;
  if (!entry) throw new Error(`world index: no entry for ${name}`);
  if (worldUrl === null) return `/world/${name}`;
  return `${worldUrl.replace(/\/+$/, '')}/${objectKey(name, entry.hash)}`;
}
