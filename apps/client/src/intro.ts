/**
 * The intro screen: what Jeck City is and how big the download is. Nothing of the game (code, world, sound) loads
 * before the player clicks "Weiter".
 */

import { introMusicNeedsClick } from './intro-music';

export interface DownloadSize {
  /** Bytes until the game runs and the area around the start has streamed in. */
  start: number;
  /** Bytes when the whole city has been explored. */
  total: number;
}

/** Dev/test runs skip the intro: ?offline=1 or ?debug=1 (the dev hooks), or explicitly ?intro=0; ?intro=1 forces it. */
export function skipIntro(params: URLSearchParams): boolean {
  if (params.get('intro') === '1') return false;
  return params.get('offline') === '1' || params.get('debug') === '1' || params.get('intro') === '0';
}

const de = (x: number, digits: number): string => x.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Rounded for reading, never understated: 183 MB → "190 MB", 1.24 GB → "1,3 GB". */
export function formatSize(bytes: number): string {
  if (bytes >= 0.95e9) return `${de(Math.ceil(bytes / 1e8) / 10, 1)} GB`;
  if (bytes >= 1e8) return `${de(Math.ceil(bytes / 1e7) * 10, 0)} MB`;
  return `${de(Math.max(1, Math.ceil(bytes / 1e6)), 0)} MB`;
}

/** The warning's sentence about the size (a generic one when the build had no world to measure). */
export function sizeText(size: DownloadSize | null): string {
  if (!size) return 'Jeck City lädt eine ganze Stadt herunter – mehrere hundert Megabyte, beim Erkunden noch mehr.';
  return `Zum Start lädt das Spiel ca. ${formatSize(size.start)}. Wer die ganze Stadt erkundet, lädt nach und nach `
    + `insgesamt bis zu ${formatSize(size.total)}.`;
}

const INTRO_CSS = `
  .nn-intro { position: fixed; z-index: 20; inset: 0; overflow-y: auto; color: #e8ecf8; font: 15px/1.5 system-ui, sans-serif;
    background: radial-gradient(120% 80% at 50% 110%, #2a2350 0%, #141a3a 45%, #0b1230 100%); transition: opacity 0.35s; }
  .nn-intro.nn-leaving { opacity: 0; pointer-events: none; }
  .nn-intro-inner { position: relative; box-sizing: border-box; min-height: 100%; max-width: 760px; margin: 0 auto;
    padding: 28px 16px 24px; display: flex; flex-direction: column; justify-content: center; }
  .nn-intro-stage { position: fixed; inset: 0; opacity: 0.3; pointer-events: none; }
  @media (min-width: 1100px) {
    .nn-intro-inner { margin: 0 0 0 max(16px, 4vw); max-width: min(760px, 54vw); }
    .nn-intro-stage { left: auto; width: calc(100vw - min(760px, 54vw) - max(16px, 4vw)); opacity: 1;
      -webkit-mask: linear-gradient(90deg, transparent, #000 12%); mask: linear-gradient(90deg, transparent, #000 12%); }
  }
  .nn-intro-start { position: fixed; z-index: 25; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 14px; cursor: pointer; background: rgba(8,10,24,0.72); backdrop-filter: blur(6px);
    transition: opacity 0.45s; }
  .nn-intro-start.nn-leaving { opacity: 0; pointer-events: none; }
  .nn-intro-start-play { width: 92px; height: 92px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: #f2c46b; color: #1a1408; font-size: 38px; padding-left: 6px; box-sizing: border-box;
    box-shadow: 0 0 0 0 rgba(242,196,107,0.6); animation: nn-pulse 1.6s infinite; }
  .nn-intro-start-text { font-size: 20px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #f2c46b; }
  .nn-intro-start-sub { font-size: 13px; opacity: 0.75; }
  @keyframes nn-pulse { 0% { box-shadow: 0 0 0 0 rgba(242,196,107,0.55); } 70% { box-shadow: 0 0 0 26px rgba(242,196,107,0); }
    100% { box-shadow: 0 0 0 0 rgba(242,196,107,0); } }
  .nn-intro-dom { display: block; width: 74px; height: auto; margin: 0 auto 6px; color: #f2c46b;
    filter: drop-shadow(0 0 14px rgba(242,196,107,0.35)); }
  .nn-intro-title { margin: 0; text-align: center; font-size: clamp(38px, 9vw, 60px); font-weight: 800; line-height: 1.05;
    letter-spacing: 0.06em; text-transform: uppercase; color: #f2c46b; text-shadow: 0 2px 24px rgba(242,196,107,0.35); }
  .nn-intro-tagline { margin: 6px 0 20px; text-align: center; font-size: 17px; opacity: 0.9; }
  .nn-intro-list { margin: 0 0 18px; padding: 0; list-style: none; display: grid; gap: 10px; }
  @media (min-width: 700px) { .nn-intro-list { grid-template-columns: 1fr 1fr; } .nn-intro-list li:last-child { grid-column: 1 / -1; } }
  .nn-intro-list li { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start; padding: 10px 12px;
    border-radius: 10px; background: rgba(255,255,255,0.05); }
  .nn-intro-list b { color: #fff; }
  .nn-intro-icon { font-size: 20px; line-height: 1.2; text-align: center; }
  .nn-intro-warn { margin: 0 0 18px; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,180,90,0.55);
    background: rgba(255,160,60,0.1); font-size: 14px; }
  .nn-intro-warn-title { display: block; margin-bottom: 4px; color: #ffc27a; font-weight: 700; letter-spacing: 0.02em; }
  .nn-intro-go { align-self: center; padding: 12px 40px; font: 700 17px/1 system-ui, sans-serif; letter-spacing: 0.06em;
    color: #1a1408; background: #f2c46b; border: 0; border-radius: 10px; cursor: pointer;
    box-shadow: 0 6px 24px rgba(242,196,107,0.3); transition: transform 0.12s, box-shadow 0.12s; }
  .nn-intro-go:hover { transform: translateY(-1px); box-shadow: 0 8px 30px rgba(242,196,107,0.45); }
  .nn-intro-go:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
  .nn-intro-foot { margin-top: 14px; text-align: center; font-size: 12px; opacity: 0.6; }
`;

/** Cologne Cathedral's west front: two spires, the nave between them. */
const DOM_SVG = `<svg class="nn-intro-dom" viewBox="0 0 64 48" aria-hidden="true" fill="currentColor">
  <path d="M14 0 L17 14 L18 14 L18 22 L20 22 L20 48 L4 48 L4 22 L6 22 L6 14 L11 14 Z"/>
  <path d="M50 0 L53 14 L58 14 L58 22 L60 22 L60 48 L44 48 L44 22 L46 22 L46 14 L47 14 Z"/>
  <path d="M20 30 L32 20 L44 30 L44 48 L20 48 Z"/>
</svg>`;

const POINTS: readonly [icon: string, html: string][] = [
  ['🏙️', '<b>Köln als offene Welt</b> – Straßen, Häuser und Plätze aus offenen Geodaten nachgebaut, Veedel für Veedel.'],
  ['👥', '<b>Alle gleichzeitig</b> – wer gerade online ist, ist mit dir in derselben Stadt unterwegs.'],
  ['🚲', '<b>Zu Fuß, mit dem Rad oder im Auto</b> – schnapp dir ein Rad vom Ständer oder steig in ein Auto, hup und dreh das Radio auf.'],
  ['🌙', '<b>Echte Tageszeit, echtes Wetter</b> – es ist so hell, dunkel, nass oder neblig wie gerade draußen in Köln.'],
  ['⌨️', '<b>Am besten am Rechner</b> – gespielt wird mit Tastatur und Maus (WASD laufen, E ein- und aussteigen, M Karte).'],
];

/** Shows the intro over `root`; resolves when the player continues (button or Enter). */
export function showIntro(root: HTMLElement, size: DownloadSize | null): Promise<void> {
  const style = document.createElement('style');
  style.textContent = INTRO_CSS;
  document.head.append(style);
  const intro = document.createElement('div');
  intro.className = 'nn-intro';
  intro.innerHTML = `<div class="nn-intro-stage"></div><div class="nn-intro-inner">
    ${DOM_SVG}
    <h1 class="nn-intro-title">Jeck City</h1>
    <p class="nn-intro-tagline">Ein Open-World-Spiel mitten in Köln – zusammen mit allen, die gerade da sind.</p>
    <ul class="nn-intro-list">${POINTS.map(([icon, html]) => `<li><span class="nn-intro-icon" aria-hidden="true">${icon}</span><span>${html}</span></li>`).join('')}</ul>
    <p class="nn-intro-warn" role="note"><span class="nn-intro-warn-title">⚠ Großer Download</span><span class="nn-intro-size"></span>
      Im Mobilfunknetz kann das dein Datenvolumen aufbrauchen – am besten im WLAN spielen.</p>
    <button class="nn-intro-go" type="button">Weiter</button>
    <p class="nn-intro-foot">Erst mit „Weiter“ wird das Spiel geladen.</p>
  </div>`;
  intro.querySelector('.nn-intro-size')!.textContent = sizeText(size);
  root.append(intro);
  const button = intro.querySelector<HTMLButtonElement>('.nn-intro-go')!;
  // the animation loads three.js on its own: the text is there at once, the scene follows
  let stopScene: (() => void) | null = null;
  let closed = false;
  void import('./intro-scene').then(({ startIntroScene }) => {
    if (!closed) stopScene = startIntroScene(intro.querySelector<HTMLElement>('.nn-intro-stage')!);
  }).catch((err: unknown) => console.error(err));
  // browsers play sound only after a click: a start overlay asks for it (the click itself starts the song)
  let start: HTMLDivElement | null = null;
  const needsClick = introMusicNeedsClick();
  const closeStart = (): void => {
    if (!start) return;
    const s = start;
    start = null;
    s.classList.add('nn-leaving');
    window.setTimeout(() => s.remove(), 500);
    button.focus({ preventScroll: true });
  };
  if (needsClick.now) {
    start = document.createElement('div');
    start.className = 'nn-intro-start';
    start.setAttribute('role', 'button');
    start.tabIndex = 0;
    start.innerHTML = `<div class="nn-intro-start-play" aria-hidden="true">▶</div>
      <div class="nn-intro-start-text">Klick zum Starten</div><div class="nn-intro-start-sub">mit Musik 🔊</div>`;
    start.addEventListener('click', closeStart);
    intro.append(start);
    start.focus({ preventScroll: true });
    // autoplay allowed after all: no click needed
    void needsClick.settled.then((needed) => { if (!needed) closeStart(); });
  } else {
    button.focus({ preventScroll: true });
  }
  return new Promise((resolve) => {
    const go = (): void => {
      closed = true;
      window.removeEventListener('keydown', onKey);
      intro.classList.add('nn-leaving');
      window.setTimeout(() => {
        stopScene?.();
        intro.remove();
        style.remove();
      }, 400);
      resolve();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (start) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          closeStart();
        }
        return;
      }
      if (e.key === 'Enter' && e.target === document.body) go();
    };
    button.addEventListener('click', go, { once: true });
    window.addEventListener('keydown', onKey);
  });
}
