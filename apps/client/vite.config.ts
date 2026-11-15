import { gzipSync } from "node:zlib";
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: true, port: 5173, strictPort: true },
  // vite preview does not compress; a real static host does. gzip text/binary assets so `npm run accept` measures
  // what a deployment would transfer.
  preview: { port: 4173 },
  plugins: [{
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
});
