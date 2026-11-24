export type PutMeta = { contentType: string; contentEncoding?: 'br'; cacheControl: string };

/** The few bucket operations publishing and pruning need; `s3Store` maps them to S3, `memoryStore` keeps them in RAM. */
export interface ObjectStore {
  /** Every key under `prefix` (all pages). */
  list(prefix: string): Promise<{ key: string; lastModified: Date }[]>;
  /** The stored bytes as uploaded (still compressed) and their encoding. */
  get(key: string): Promise<{ body: Uint8Array; contentEncoding?: 'br' }>;
  put(key: string, body: Uint8Array, meta: PutMeta): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

/**
 * In-memory store for tests. `puts` records every put key in order, `meta` the last metadata per key.
 * `lastModified` advances one second per put, so "newest" is deterministic.
 */
export function memoryStore(): ObjectStore & { puts: string[]; meta: Map<string, PutMeta> } {
  const objects = new Map<string, { body: Uint8Array; lastModified: Date }>();
  const puts: string[] = [];
  const meta = new Map<string, PutMeta>();
  let clock = Date.UTC(2026, 0, 1);
  return {
    puts,
    meta,
    async list(prefix) {
      return [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, o]) => ({ key, lastModified: o.lastModified }));
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) throw new Error(`memory store: no object ${key}`);
      const encoding = meta.get(key)?.contentEncoding;
      return encoding ? { body: o.body.slice(), contentEncoding: encoding } : { body: o.body.slice() };
    },
    async put(key, body, m) {
      clock += 1000;
      objects.set(key, { body: body.slice(), lastModified: new Date(clock) });
      meta.set(key, { ...m });
      puts.push(key);
    },
    async delete(keys) {
      for (const key of keys) {
        objects.delete(key);
        meta.delete(key);
      }
    },
  };
}
