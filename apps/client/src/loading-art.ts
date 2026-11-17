/**
 * Illustrated backdrop of the loading screen: comic pictures of Köln im Karneval that slowly pan (one after another,
 * crossfading) until the game is ready; a single picture pans back and forth.
 */

export const LOADING_ART = ['/loading/karneval.jpg'];
/** How long one picture is shown before the next one fades in. */
export const SLIDE_MS = 8000;
/** Crossfade between two pictures. */
export const FADE_MS = 1600;

export interface Pan {
  from: string;
  to: string;
}

/**
 * The slow camera move over picture `i` (the CSS transform at its start and end): alternately from left to right and
 * back, zooming in a little. The scale keeps the picture covering the screen at every offset.
 */
export function panFor(i: number): Pan {
  const dir = i % 2 === 0 ? 1 : -1;
  const x = 2.5 * dir;
  return { from: `scale(1.08) translateX(${-x}%)`, to: `scale(1.14) translateX(${x}%)` };
}

const ART_CSS = `
  .nn-art { position: fixed; z-index: 1; inset: 0; overflow: hidden; background: #0b1230; transition: opacity 0.8s; }
  .nn-art.nn-hidden { opacity: 0; pointer-events: none; }
  .nn-art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0;
    transition: opacity ${FADE_MS}ms ease-in-out; will-change: transform, opacity; }
  .nn-art img.nn-on { opacity: 1; }
`;

export class LoadingArt {
  private readonly root: HTMLDivElement;
  private readonly imgs: HTMLImageElement[] = [];
  private index = -1;
  private timer = 0;
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(parent: HTMLElement, sources: readonly string[] = LOADING_ART) {
    const style = document.createElement('style');
    style.textContent = ART_CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'nn-art';
    parent.append(this.root);
    // start with a random picture so a reload does not always show the same one
    const start = Math.floor(Math.random() * sources.length);
    const order = sources.map((_, k) => sources[(start + k) % sources.length]!);
    for (const src of order) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = src;
      this.root.append(img);
      this.imgs.push(img);
    }
    const first = this.imgs[0];
    if (!first) return;
    const go = (): void => {
      this.next();
      this.timer = window.setInterval(() => this.next(), SLIDE_MS);
    };
    if (first.complete) go();
    else first.addEventListener('load', go, { once: true });
  }

  private next(): void {
    const prev = this.imgs[this.index];
    this.index = (this.index + 1) % this.imgs.length;
    const img = this.imgs[this.index]!;
    if (img === prev) return; // a single picture keeps its endless pan
    const single = this.imgs.length === 1;
    if (!this.still) {
      const pan = panFor(this.index);
      img.getAnimations().forEach((a) => a.cancel());
      // runs on past the switch so it is still moving while it fades out
      img.animate([{ transform: pan.from }, { transform: pan.to }], single
        ? { duration: 2 * SLIDE_MS, easing: 'ease-in-out', iterations: Infinity, direction: 'alternate' }
        : { duration: SLIDE_MS + FADE_MS, easing: 'linear', fill: 'forwards' });
    }
    img.classList.add('nn-on');
    prev?.classList.remove('nn-on');
  }

  /** Fades the pictures out and frees them. */
  hide(): void {
    window.clearInterval(this.timer);
    this.root.classList.add('nn-hidden');
    window.setTimeout(() => this.root.remove(), 900);
  }
}
