import { parseWorldIndex, worldFileUrl, WORLD_INDEX_FILE, type WorldIndex } from '@nn/shared';
import { FetchError } from './errors';

/** The global fetch at call time (so a fetch wrapped later, e.g. by the download meter, is used). */
const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/** fetch that turns network failures (offline, DNS) and non-ok statuses into FetchError (status 0 for the former). */
export async function fetchOk(url: string, init?: RequestInit, fetchFn: typeof fetch = globalFetch): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch {
    throw new FetchError(url, 0);
  }
  if (!res.ok) throw new FetchError(url, res.status);
  return res;
}

/**
 * Every world file by its logical name (as in the manifest): from the object-storage bucket when the server names
 * one (immutable objects keyed by content hash), otherwise from /world/ (revalidated: a stale copy after a deploy
 * would not match the server's world).
 */
export class WorldFiles {
  /** url(name) → name, for nameOf(). */
  private readonly names = new Map<string, string>();

  constructor(private readonly index: WorldIndex, private readonly worldUrl: string | null, private readonly fetchFn: typeof fetch = globalFetch) {
    for (const name of Object.keys(index.files)) this.names.set(this.url(name), name);
  }

  /** Address of a world file; throws for a name the index does not have. */
  url(name: string): string {
    return worldFileUrl(this.index, this.worldUrl, name);
  }

  /** Downloads a world file; rejects with FetchError when the download fails. */
  async fetch(name: string): Promise<Response> {
    return fetchOk(this.url(name), this.worldUrl === null ? { cache: 'no-cache' } : undefined, this.fetchFn);
  }

  /** The logical name of an address url() returned; null for any other URL. */
  nameOf(url: string): string | null {
    return this.names.get(url) ?? null;
  }
}

/**
 * Loads /world/index.json and the server's /config.json (both revalidated). Without a usable /config.json (offline
 * mode without a game server, an older server) the world comes from /world/. Rejects when the index cannot be loaded.
 */
export async function loadWorldFiles(fetchFn: typeof fetch = globalFetch): Promise<{ files: WorldFiles; indexBytes: ArrayBuffer }> {
  const [indexBytes, worldUrl] = await Promise.all([
    fetchOk(`/world/${WORLD_INDEX_FILE}`, { cache: 'no-cache' }, fetchFn).then((r) => r.arrayBuffer()),
    configWorldUrl(fetchFn),
  ]);
  const index = parseWorldIndex(JSON.parse(new TextDecoder().decode(indexBytes)));
  return { files: new WorldFiles(index, worldUrl, fetchFn), indexBytes };
}

/** `worldUrl` of /config.json; null when it is not answered with 200 or names no bucket. */
async function configWorldUrl(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchFn('/config.json', { cache: 'no-cache' });
    if (res.status !== 200) return null;
    const { worldUrl } = (await res.json()) as { worldUrl?: unknown };
    return typeof worldUrl === 'string' && worldUrl !== '' ? worldUrl : null;
  } catch {
    return null;
  }
}
