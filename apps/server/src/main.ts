import { loadConfig } from './config';
import { log } from './log';
import { startServer } from './server';

try {
  await startServer(loadConfig(process.env), { exitOnShutdown: true });
} catch (e) {
  log('error', 'startup failed', { error: String(e), stack: (e as Error).stack });
  process.exit(1);
}
