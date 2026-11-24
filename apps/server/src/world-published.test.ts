import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWorldPublished, WORLD_CHECK_TIMEOUT_MS } from './world-published';

const WORLD_URL = 'https://b.example/';
const HASH = '0123456789ab';
const answering = (status: number) => vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));

describe('checkWorldPublished', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('true for 200, false for 404, false when fetch rejects, false after the timeout', async () => {
    expect(await checkWorldPublished(WORLD_URL, HASH, answering(200))).toBe(true);
    expect(await checkWorldPublished(WORLD_URL, HASH, answering(404))).toBe(false);
    expect(await checkWorldPublished(WORLD_URL, HASH, vi.fn<typeof fetch>().mockRejectedValue(new Error('down')))).toBe(false);

    vi.useFakeTimers();
    // a fetch that only ever ends through its abort signal
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    let settled: boolean | undefined;
    void checkWorldPublished(WORLD_URL, HASH, hanging).then((v) => { settled = v; });
    await vi.advanceTimersByTimeAsync(WORLD_CHECK_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(WORLD_CHECK_TIMEOUT_MS).toBe(5000);
  });

  it('asks for <worldUrl>worlds/<hash>.json with HEAD', async () => {
    const f = answering(200);
    await checkWorldPublished(WORLD_URL, HASH, f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe('https://b.example/worlds/0123456789ab.json');
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'HEAD' });
  });
});
