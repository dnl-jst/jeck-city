import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** Cache-Control by location: the page always revalidates, hashed Vite assets never change, the world rarely does. */
export function cacheControl(urlPath: string): string {
  if (urlPath === '/index.html') return 'no-cache';
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath.startsWith('/world/')) return 'public, max-age=3600';
  return 'public, max-age=3600';
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/**
 * Request handler for the built client (apps/client/dist). GET/HEAD only; a path that leaves `root` is a 404.
 * Pre-compressed `<file>.br` / `<file>.gz` next to a file are served when Accept-Encoding allows them.
 * Calls `next` for other methods.
 */
export function staticHandler(root: string): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
  const base = resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    void serve(base, req, res).catch(() => {
      if (!res.headersSent) notFound(res);
      else res.destroy();
    });
  };
}

async function serve(base: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  } catch {
    return notFound(res);
  }
  if (urlPath.includes('\0')) return notFound(res);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = resolve(join(base, urlPath));
  if (file !== base && !file.startsWith(base + sep)) return notFound(res);

  const accept = String(req.headers['accept-encoding'] ?? '');
  let encoding: 'br' | 'gzip' | null = null;
  let path = file;
  let size = await fileSize(file);
  if (size === null) return notFound(res);
  for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (!new RegExp(`(^|[,\\s])${enc}(\\s*;|\\s*,|$)`).test(accept)) continue;
    const s = await fileSize(file + ext);
    if (s !== null) {
      encoding = enc;
      path = file + ext;
      size = s;
      break;
    }
  }

  const rel = '/' + file.slice(base.length + 1).split(sep).join('/');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': cacheControl(rel),
    Vary: 'Accept-Encoding',
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}
