import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import { measureDownload } from "./src/build/download-size";

// dev: the client port (NN_CLIENT_PORT) and the game server it proxies to (PORT, as for the server itself) are configurable,
// so a second checkout can run next to the first
const clientPort = Number(process.env.NN_CLIENT_PORT ?? 5173);
const target = `http://localhost:${process.env.PORT ?? 2567}`;
// Colyseus 0.18 talks to the page's own origin: POST /matchmake/<method>/<room>, then a WebSocket to /<processId>/<roomId>
// (two url-safe ids); plus /healthz. The regex keeps Vite's own paths (/src/..., /@vite/..., /world/...) out of it.
const proxy = {
  '/healthz': { target },
  '/matchmake': { target },
  '^/[A-Za-z0-9_-]{8,}/[A-Za-z0-9_-]{8,}(\\?.*)?$': { target, ws: true },
};

// the intro screen's download warning: compressed size of the generated world, audio and portraits (null without a world)
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(async (): Promise<UserConfig> => ({
  define: { __NN_DOWNLOAD__: JSON.stringify(await measureDownload(here("public"), here("node_modules/.cache/nn-download-size.json"))) },
  // No hot reload: a saved file must not reload the game under a player (the world takes a while to load, and an
  // online session would rejoin). Reload the page to see a change; NN_HMR=1 turns hot reload back on.
  server: { host: true, port: clientPort, strictPort: true, proxy, hmr: process.env.NN_HMR === '1' },
  // vite preview does not compress; a real static host does. gzip text/binary assets so `npm run accept` measures
  // what a deployment would transfer.
  preview: { port: 4173 },
  plugins: [{
    // dev only: POST /__nnlog lines from devices without a console (phones, tablets) into this terminal (src/devlog.ts)
    name: "nn-devlog",
    configureServer(server) {
      server.middlewares.use("/__nnlog", (req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); if (body.length > 20000) req.destroy(); });
        req.on("end", () => {
          const ua = String(req.headers["user-agent"] ?? "");
          const dev = /iPad|Macintosh/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
          for (const line of body.split("\n")) if (line) console.log(`[${dev}] ${line}`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  }, {
    name: "preview-gzip",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/\.(js|json|glb|bin|css|html)$/.test((req.url ?? "").split("?")[0]!) || !String(req.headers["accept-encoding"]).includes("gzip")) return next();
        res.setHeader("Vary", "Accept-Encoding");
        // 304 and HEAD responses carry no body: leave them alone
        if (req.method === "HEAD" || req.headers["if-none-match"] || req.headers["if-modified-since"]) return next();
        const end = res.end.bind(res);
        const parts: Buffer[] = [];
        res.setHeader("Content-Encoding", "gzip");
        res.removeHeader("Content-Length");
        const setHeader = res.setHeader.bind(res);
        res.setHeader = ((k: string, v: never) => (k.toLowerCase() === "content-length" ? res : setHeader(k, v))) as typeof res.setHeader;
        const writeHead = res.writeHead.bind(res) as (status: number, headers?: Record<string, unknown>) => typeof res;
        // sirv passes Content-Length to writeHead; the gzipped body is shorter, so drop it (chunked instead)
        res.writeHead = ((status: number, headers?: Record<string, unknown>) => {
          if (headers) for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-length") delete headers[k];
          return writeHead(status, headers);
        }) as typeof res.writeHead;
        res.write = ((c: Buffer | string) => { parts.push(Buffer.from(c)); return true; }) as typeof res.write;
        res.end = ((c?: Buffer | string) => {
          if (c) parts.push(Buffer.from(c));
          const body = gzipSync(Buffer.concat(parts), { level: 6 });
          return end(body);
        }) as typeof res.end;
        next();
      });
    },
  }],
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
}));
