import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { defineRoom, defineServer, matchMaker, WebSocketTransport } from 'colyseus';
import { loadWorldAssets, WORLD_INDEX_FILE, worldHash } from '@nn/shared';
import type { Config } from './config';
import { log, setLogLevel } from './log';
import { staticHandler } from './static';
import { WeatherService } from './weather';
import { nippesRoom, type NippesRoom } from './room';
import { SERVER_VERSION } from './version';
import { checkWorldPublished } from './world-published';

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
  if (!existsSync(join(cfg.worldDir, WORLD_INDEX_FILE))) {
    throw new Error(`${WORLD_INDEX_FILE} fehlt in ${cfg.worldDir}: 'npm run world:index' ausführen`);
  }
  const [assets, hash] = await Promise.all([loadWorldAssets(read), read(WORLD_INDEX_FILE).then(worldHash)]);

  const transport = new WebSocketTransport();
  let room: NippesRoom | undefined;
  /** Whether worlds/<hash>.json is in the bucket: null without WORLD_URL and until the check has answered. */
  let worldPublished: boolean | null = null;
  const server = defineServer({
    rooms: { nippes: defineRoom(nippesRoom({ cfg, assets, worldHash: hash })) },
    transport,
    greet: false,
    express: (app) => {
      app.get('/healthz', (_req: unknown, res: { json(b: unknown): void }) => res.json({
        ...(room?.health() ?? { players: 0, tickP95Ms: 0, dropped: 0, version: SERVER_VERSION, worldHash: hash }),
        worldPublished,
      }));
      app.get('/config.json', (_req: unknown, res: { setHeader(k: string, v: string): void; json(b: unknown): void }) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.json({ worldUrl: cfg.worldUrl });
      });
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
  let weather: WeatherService | undefined;
  if (cfg.weather === 'live') {
    weather = new WeatherService({ onUpdate: (w) => room!.setWeather(w) });
    weather.start();
  } else if (cfg.weather !== 'off') {
    room.setWeather(cfg.weather.fixed);
  }
  log('info', 'listening', { port, worldHash: hash, dev: cfg.dev });
  if (cfg.worldUrl) {
    // never awaited: the bucket must neither delay nor fail the start
    const worldUrl = cfg.worldUrl;
    void checkWorldPublished(worldUrl, hash).then((ok) => {
      worldPublished = ok;
      if (!ok) log('warn', 'world not published', { worldUrl, worldHash: hash });
    });
  }
  return { port, room, stop: () => {
    weather?.stop();
    return server.gracefullyShutdown(false);
  } };
}
