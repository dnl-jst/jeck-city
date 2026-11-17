/**
 * Dev server only: sends the page's errors, warnings and a few boot milestones to the dev server's terminal
 * (vite.config.ts, POST /__nnlog). Phones and tablets have no reachable console; this is how their failures show.
 */
export function startDevLog(): void {
  const t0 = performance.now();
  const queue: string[] = [];
  let timer = 0;
  const flush = (): void => {
    timer = 0;
    if (!queue.length) return;
    const body = queue.splice(0).join('\n');
    if (!navigator.sendBeacon?.('/__nnlog', body)) void fetch('/__nnlog', { method: 'POST', body, keepalive: true }).catch(() => {});
  };
  const send = (kind: string, ...parts: unknown[]): void => {
    const text = parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message} ${p.stack ?? ''}` : typeof p === 'string' ? p : safeJson(p))).join(' ');
    queue.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${kind} ${text}`.slice(0, 2000));
    if (!timer) timer = window.setTimeout(flush, 300);
  };
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      send(level, ...a);
      orig(...a);
    };
  }
  window.addEventListener('error', (e) => send('onerror', e.error ?? e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => send('rejection', e.reason));
  window.addEventListener('pagehide', () => { send('pagehide'); flush(); });
  const mem = (): string => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return m ? ` heap ${(m.usedJSHeapSize / 1e6).toFixed(0)} MB` : '';
  };
  send('start', navigator.userAgent, `${innerWidth}x${innerHeight}@${devicePixelRatio}`, `touchPoints ${navigator.maxTouchPoints}`);
  // boot progress every 3 s until the game runs (or fails): where a stuck loading screen stops
  const poll = window.setInterval(() => {
    const status = document.querySelector('.nn-loading-status')?.textContent ?? '';
    const bar = (document.querySelector('.nn-loading-fill') as HTMLElement | null)?.style.width ?? '';
    const ready = window.__nnReady;
    send('boot', `ready=${String(ready)} bar=${bar} status="${status}"${mem()}`);
    if (ready !== undefined) window.clearInterval(poll);
  }, 3000);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
