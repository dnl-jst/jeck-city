import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { defineRoom, defineServer, matchMaker, WebSocketTransport } from 'colyseus';
import { loadWorldAssets, worldHash } from '@nn/shared';
import type { Config } from './config';
import { log, setLogLevel } from './log';
import { staticHandler } from './static';
import { nippesRoom, type NippesRoom } from './room';

export type RunningServer = { port: number; room: NippesRoom; stop(): Promise<void> };

/**
 * Loads the world, starts Colyseus on cfg.port (0 = any free port) and creates the one 'nippes' room.
 * `exitOnShutdown` (main): SIGINT/SIGTERM shut the server down gracefully and end the process.
 */
export async function startServer(cfg: Config, opts: { exitOnShutdown?: boolean } = {}): Promise<RunningServer> {
  setLogLevel(cfg.logLevel);
  const read = async (file: string): Promise<ArrayBuffer> => {
    const b = await readFile(join(cfg.worldDir, file));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const [assets, hash] = await Promise.all([loadWorldAssets(read), read('manifest.json').then(worldHash)]);

  const transport = new WebSocketTransport();
  let room: NippesRoom | undefined;
  const server = defineServer({
    rooms: { nippes: defineRoom(nippesRoom({ cfg, assets, worldHash: hash })) },
    transport,
    greet: false,
    express: (app) => {
      app.get('/healthz', (_req: unknown, res: { json(b: unknown): void }) => res.json(room?.health() ?? { players: 0, tickP95Ms: 0, dropped: 0 }));
      if (cfg.clientDir) {
        const serve = staticHandler(cfg.clientDir);
        app.get('/', serve); // an explicit root route keeps Colyseus from adding its own greeting there
        app.use(serve);
      }
    },
    gracefullyShutdown: opts.exitOnShutdown ?? false,
    ...(cfg.publicUrl ? { publicAddress: cfg.publicUrl } : {}),
  });
  await server.listen(cfg.port);
  const port = (transport.server!.address() as AddressInfo).port;
  const listing = await matchMaker.createRoom('nippes', {});
  room = matchMaker.getLocalRoomById(listing.roomId) as NippesRoom;
  log('info', 'listening', { port, worldHash: hash, dev: cfg.dev });
  return { port, room, stop: () => server.gracefullyShutdown(false) };
}
