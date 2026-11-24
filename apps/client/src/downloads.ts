/**
 * Download meter for the loading screen: counts the bytes of every fetch() while the game boots (world chunks,
 * physics data, models, sounds) for a detailed progress bar with size, speed and time left.
 *
 * Sizes are wire bytes (what goes over the network). A precompressed response (Content-Encoding br/gzip) reports its
 * compressed Content-Length, but its body stream yields the decompressed bytes; while it is still arriving its wire
 * bytes are estimated with the compression ratio of the encoded responses finished so far.
 */

export type DownloadCategory = 'physics' | 'city' | 'models' | 'map' | 'sound' | 'other';

export const CATEGORY_LABELS: Record<DownloadCategory, string> = {
  physics: 'Physik', city: 'Straßen und Häuser', models: 'Fahrzeuge und Figuren', map: 'Karte', sound: 'Ton', other: 'Sonstiges',
};

/** Rows in this order (categories without any download are left out). */
const ORDER: readonly DownloadCategory[] = ['physics', 'city', 'models', 'map', 'sound', 'other'];

/** Logical file name of a URL (a bucket URL carries only a content hash); null = use the URL's own file name. */
export type NameOf = (url: string) => string | null;

/** Which part of the game a URL belongs to (by file name, or the logical name `nameOf` gives). */
export function categoryOf(url: string, nameOf?: NameOf): DownloadCategory {
  const path = url.split(/[?#]/)[0]!;
  const file = nameOf?.(url) ?? path.slice(path.lastIndexOf('/') + 1);
  if (path.includes('/audio/')) return 'sound';
  if (file === 'collision.bin' || file === 'terrain.bin' || file === 'transit-collision.bin') return 'physics';
  if (file.startsWith('chunk_') || file.startsWith('model_')) return 'city';
  if (/^(car|bike|rack|character)_/.test(file)) return 'models';
  if (file === 'map.json' || file === 'manifest.json' || file === 'index.json' || file === 'roadgraph.json') return 'map';
  return 'other';
}

/** Compressed / decompressed size assumed until the first encoded response has finished. */
const DEFAULT_RATIO = 0.6;
/** Speed = bytes over the last SPEED_WINDOW_MS. */
const SPEED_WINDOW_MS = 2_000;

interface Entry {
  cat: DownloadCategory;
  /** Content-Length (wire bytes), null if unknown. */
  total: number | null;
  encoded: boolean;
  /** Body bytes received so far (decompressed when encoded). */
  decoded: number;
  done: boolean;
  /** Finished with the whole body (not aborted). */
  complete: boolean;
}

export interface CategoryProgress {
  cat: DownloadCategory;
  label: string;
  received: number;
  total: number;
}

export interface DownloadSnapshot {
  /** Wire bytes received (estimated for encoded responses in flight). */
  received: number;
  /** Wire bytes of all downloads started so far (unknown sizes count as received). */
  total: number;
  /** Bytes per second over the last couple of seconds; null until there is a long enough window. */
  speed: number | null;
  /** Downloads still in flight. */
  active: number;
  categories: CategoryProgress[];
}

export class DownloadMeter {
  private readonly entries = new Map<number, Entry>();
  private nextId = 0;
  private wireDone = 0;
  private decodedDone = 0;
  private readonly samples: { t: number; bytes: number }[] = [];

  /** `nameOf` names world files fetched from the bucket (asked when a download begins). */
  constructor(private readonly nameOf?: NameOf) {}

  /** A response's headers arrived; returns its id for data() and end(). */
  begin(url: string, total: number | null, encoded: boolean): number {
    const id = this.nextId++;
    this.entries.set(id, { cat: categoryOf(url, this.nameOf), total, encoded, decoded: 0, done: false, complete: false });
    return id;
  }

  /** `bytes` more body bytes of download `id`. */
  data(id: number, bytes: number): void {
    const e = this.entries.get(id);
    if (e && !e.done) e.decoded += bytes;
  }

  /** Download `id` finished (complete) or failed / was aborted (only what arrived counts). */
  end(id: number, complete = true): void {
    const e = this.entries.get(id);
    if (!e || e.done) return;
    e.done = true;
    e.complete = complete;
    if (complete && e.encoded && e.total !== null && e.decoded > 0) {
      this.wireDone += e.total;
      this.decodedDone += e.decoded;
    }
  }

  private ratio(): number {
    return this.decodedDone > 0 ? this.wireDone / this.decodedDone : DEFAULT_RATIO;
  }

  /** Wire bytes received of one download. */
  private wire(e: Entry): number {
    if (e.complete) return e.encoded && e.total !== null ? e.total : e.decoded;
    const est = e.encoded ? e.decoded * this.ratio() : e.decoded;
    return e.total === null ? est : Math.min(e.total, est);
  }

  /** Totals now (ms on a monotonic clock); call regularly, it also feeds the speed window. */
  snapshot(now: number): DownloadSnapshot {
    const cats = new Map<DownloadCategory, { received: number; total: number }>();
    let received = 0, total = 0, active = 0;
    for (const e of this.entries.values()) {
      const r = this.wire(e);
      // a failed download only counts what arrived
      const t = e.done ? r : Math.max(e.total ?? r, r);
      received += r;
      total += t;
      if (!e.done) active++;
      const c = cats.get(e.cat) ?? { received: 0, total: 0 };
      c.received += r;
      c.total += t;
      cats.set(e.cat, c);
    }
    this.samples.push({ t: now, bytes: received });
    while (this.samples.length > 2 && this.samples[1]!.t <= now - SPEED_WINDOW_MS) this.samples.shift();
    const first = this.samples[0]!;
    const dt = now - first.t;
    const speed = dt >= 400 ? ((received - first.bytes) * 1000) / dt : null;
    const categories = ORDER.filter((c) => cats.has(c)).map((cat) => ({ cat, label: CATEGORY_LABELS[cat], ...cats.get(cat)! }));
    return { received, total, speed, active, categories };
  }
}

/** Something with a fetch (window/globalThis; a stub in tests). */
interface FetchScope {
  fetch: typeof fetch;
}

/**
 * Counts every fetch() made through `scope` in `meter` (a cloned body is read alongside; the caller's response is
 * untouched). Returns the function that restores the original fetch; downloads already running keep being counted.
 */
export function trackFetch(meter: DownloadMeter, scope: FetchScope = globalThis): () => void {
  const original = scope.fetch;
  scope.fetch = async (input, init) => {
    const res = await original.call(globalThis, input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // blob:/data: URLs (textures embedded in a glTF) are already in memory, not downloads
    if (!res.body || /^(blob|data):/.test(url)) return res;
    const length = Number(res.headers.get('content-length'));
    const id = meter.begin(url, length > 0 ? length : null, !!res.headers.get('content-encoding'));
    const reader = res.clone().body!.getReader();
    void (async () => {
      let complete = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          meter.data(id, value.byteLength);
        }
        complete = true;
      } catch {
        // aborted or failed: counts what arrived
      } finally {
        meter.end(id, complete);
      }
    })();
    return res;
  };
  return () => {
    scope.fetch = original;
  };
}

const de = (x: number, digits: number): string => x.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** 1234567 → "1,2 MB" (decimal units). */
export function formatBytes(b: number): string {
  if (b < 999_500) return `${de(Math.round(b / 1e3), 0)} kB`;
  return `${de(b / 1e6, b < 1e8 ? 1 : 0)} MB`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

/** Seconds left → "noch ca. 12 s" / "noch ca. 3 min"; '' when there is nothing sensible to say. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `noch ca. ${Math.max(1, Math.round(seconds))} s`;
  return `noch ca. ${Math.round(seconds / 60)} min`;
}

/** The summary line: "42,3 MB von 97,8 MB · 3,4 MB/s · noch ca. 16 s". */
export function downloadSummary(s: DownloadSnapshot): string {
  const parts = [`${formatBytes(s.received)} von ${formatBytes(s.total)}`];
  if (s.speed !== null && s.active > 0) {
    parts.push(formatSpeed(s.speed));
    if (s.speed > 1e3) {
      const eta = formatEta((s.total - s.received) / s.speed);
      if (eta) parts.push(eta);
    }
  }
  return parts.join(' · ');
}
