// Usage: npm run dev
// Starts the game server (npm start -w @nn/server, PORT default 2567) and the client's Vite dev server (NN_CLIENT_PORT,
// default 5173; it proxies to the server on PORT) together. Ctrl+C or either one exiting stops both.
// When the world is rebuilt (npm run pipeline writes apps/client/public/world/manifest.json last), the game server is
// restarted: it loads the world and its hash once at start, and with a stale hash every join fails with "Neue Version".
import { spawn } from 'node:child_process';
import { statSync, unwatchFile, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const detached = process.platform !== 'win32';
const MANIFEST = fileURLToPath(new URL('../apps/client/public/world/manifest.json', import.meta.url));
/** Quiet time after the last manifest change before the restart (the write may come in pieces). */
const SETTLE_MS = 2000;

let stopping = false;
let restarting = false;
const startServer = () => spawn(npm, ['start', '-w', '@nn/server'], { stdio: 'inherit', detached });
let server = startServer();
const client = spawn(npm, ['run', 'dev', '-w', '@nn/client'], { stdio: 'inherit', detached });

/** Signals the whole process group of a child (npm → tsx/vite → node) so no port stays taken. */
function kill(c) {
  if (c.exitCode !== null || !c.pid) return;
  try { process.kill(detached ? -c.pid : c.pid, 'SIGTERM'); } catch { /* already gone */ }
}
const exited = (c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r)));

function stop(code) {
  if (stopping) return;
  stopping = true;
  unwatchFile(MANIFEST);
  for (const c of [server, client]) kill(c);
  setTimeout(() => process.exit(code), 3000).unref();
  Promise.all([server, client].map(exited)).then(() => process.exit(code));
}

function watchServer(c) {
  c.on('exit', (code) => {
    if (stopping || restarting) return;
    console.error(`[dev] the game server exited (${code}), stopping the client`);
    stop(code ?? 1);
  });
}
watchServer(server);
client.on('exit', (code) => { if (!stopping) console.error(`[dev] the client exited (${code}), stopping the server`); stop(code ?? 1); });

async function restartServer() {
  if (stopping || restarting) return;
  restarting = true;
  console.log('[dev] world rebuilt (manifest.json changed): restarting the game server');
  kill(server);
  await exited(server);
  server = startServer();
  watchServer(server);
  restarting = false;
}

const mtime = () => { try { return statSync(MANIFEST).mtimeMs; } catch { return 0; } };
let seen = mtime();
let timer;
watchFile(MANIFEST, { interval: 1000 }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const now = mtime();
    if (now === 0 || now === seen) return;
    seen = now;
    void restartServer();
  }, SETTLE_MS);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(0));
