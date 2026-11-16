// Usage: npm run dev
// Starts the game server (npm start -w @nn/server, PORT default 2567) and the client's Vite dev server (NN_CLIENT_PORT,
// default 5173; it proxies to the server on PORT) together. Ctrl+C or either one exiting stops both.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['start', '-w', '@nn/server'], { stdio: 'inherit', detached: process.platform !== 'win32' }),
  spawn(npm, ['run', 'dev', '-w', '@nn/client'], { stdio: 'inherit', detached: process.platform !== 'win32' }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  // each child leads its own process group (npm → tsx/vite → node): signal the whole group so no port stays taken
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    try { process.kill(process.platform === 'win32' ? c.pid : -c.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 3000).unref();
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.once('exit', r))))).then(() => process.exit(code));
}
for (const c of children) c.on('exit', (code) => { if (!stopping) console.error(`[dev] a process exited (${code}), stopping the other`); stop(code ?? 1); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(0));
