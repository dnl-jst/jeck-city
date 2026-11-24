import { worldObjectKey } from '@nn/shared';

/** How long the bucket gets to answer the HEAD request. */
export const WORLD_CHECK_TIMEOUT_MS = 5000;

/**
 * Whether the world with `worldHash` is published under `worldUrl` (which ends in '/'): a HEAD request on
 * `<worldUrl>worlds/<hash>.json`. Any error, any non-2xx answer and the timeout count as not published.
 */
export async function checkWorldPublished(worldUrl: string, worldHash: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), WORLD_CHECK_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${worldUrl}${worldObjectKey(worldHash)}`, { method: 'HEAD', signal: abort.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
