import { showIntro, skipIntro, type DownloadSize } from './intro';

declare global {
  /** Measured at build time (vite.config.ts); null when the build had no generated world. */
  const __NN_DOWNLOAD__: DownloadSize | null;
}

// the intro first: the game's code, world, models and sound only load once the player continues
if (!skipIntro(new URLSearchParams(location.search))) await showIntro(document.body, __NN_DOWNLOAD__);
await import('./boot');
