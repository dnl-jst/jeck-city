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

/**
 * Cache-Control by location: hashed Vite assets never change; the page and the world always revalidate (ETag), so a
 * returning player never mixes a new manifest with old world files after a deploy; the rest caches for an hour.
 */
export function cacheControl(urlPath: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath === '/index.html' || urlPath.startsWith('/world/')) return 'no-cache';
  return 'public, max-age=3600';
}

type FileInfo = { size: number; mtimeMs: number };

async function fileInfo(path: string): Promise<FileInfo | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Validator of the served file (size and modification time; the encoding tells the variants apart). */
const etagOf = (f: FileInfo, encoding: string | null): string =>
  `"${f.size.toString(36)}-${Math.floor(f.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ''}"`;

/** Whether an If-None-Match header names `etag` (weak comparison, as RFC 9110 asks for GET) or is `*`. */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
  });
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
  let info = await fileInfo(file);
  if (info === null) return notFound(res);
  for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (!new RegExp(`(^|[,\\s])${enc}(\\s*;|\\s*,|$)`).test(accept)) continue;
    const f = await fileInfo(file + ext);
    if (f !== null) {
      encoding = enc;
      path = file + ext;
      info = f;
      break;
    }
  }

  const rel = '/' + file.slice(base.length + 1).split(sep).join('/');
  const etag = etagOf(info, encoding);
  const common = { ETag: etag, 'Cache-Control': cacheControl(rel), Vary: 'Accept-Encoding' };
  if (matches(req.headers['if-none-match'], etag)) {
    res.writeHead(304, common);
    return void res.end();
  }
  res.writeHead(200, {
    ...common,
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}
