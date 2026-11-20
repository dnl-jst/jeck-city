import { showIntro, skipIntro, type DownloadSize } from './intro';
import { startIntroMusic } from './intro-music';
import { startDevLog } from './devlog';
import { preventPageZoom } from './no-zoom';
import { showVersion } from './version-label';

declare global {
  /** Measured at build time (vite.config.ts); null when the build had no generated world. */
  const __NN_DOWNLOAD__: DownloadSize | null;
  /** `version` of the root package.json at build time (vite.config.ts). */
  const __NN_VERSION__: string;
}

if (import.meta.env.DEV) startDevLog();
preventPageZoom();
showVersion(document.body, __NN_VERSION__, new URLSearchParams(location.search).get('debug') === '1');

// the intro first: the game's code, world, models and sound only load once the player continues
// the title song plays on the intro and while loading; boot.ts fades it out when the game starts
if (!skipIntro(new URLSearchParams(location.search))) {
  startIntroMusic(document.body);
  await showIntro(document.body, __NN_DOWNLOAD__);
}
await import('./boot');
