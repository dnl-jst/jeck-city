import { FetchError, NoWebGLError } from './errors';

/** User-facing (German) text for a boot failure. */
export function bootErrorMessage(e: unknown): string {
  if (e instanceof NoWebGLError) return 'Dein Browser kann leider kein 3D (WebGL). Probier es mit einem aktuellen Chrome, Firefox oder Safari.';
  if (e instanceof FetchError) return 'Nippes konnte nicht geladen werden. Bitte lade die Seite neu.';
  return 'Da ist was schiefgelaufen. Bitte lade die Seite neu.';
}

export const CONTROLS_HINT = 'WASD laufen · Shift rennen · Leertaste springen · E ein-/aussteigen · Maus umsehen (klicken)';

/** Stylesheet of the HUD. The faded-out loading box must not catch the click that requests pointer lock. */
export const HUD_CSS = `
  .nn-loading { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(320px, 70vw);
    color: #e8ecf8; font: 15px/1.4 system-ui, sans-serif; letter-spacing: 0.05em; text-align: center; transition: opacity 0.6s; }
  .nn-loading.nn-hidden { opacity: 0; pointer-events: none; }
  .nn-loading-track { margin-top: 10px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.18); overflow: hidden; }
  .nn-loading-fill { height: 100%; width: 0; background: #f2c46b; transition: width 0.15s; }
  .nn-loading-status { margin-top: 8px; font-size: 12px; opacity: 0.8; }
  .nn-loading-controls { margin-top: 18px; font-size: 12px; opacity: 0.65; }
  .nn-error { color: #ffb4a8; }
  .nn-attribution { position: fixed; right: 8px; bottom: 6px; color: rgba(255,255,255,0.85);
    font: 11px/1.3 system-ui, sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,0.8); pointer-events: none; }
  .nn-hint, .nn-note { position: fixed; left: 50%; transform: translateX(-50%); color: #fff; pointer-events: none;
    font: 13px/1.3 system-ui, sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  .nn-hint { bottom: 22px; padding: 4px 10px; border-radius: 12px; background: rgba(10,12,20,0.45); }
  .nn-hint:empty, .nn-note:empty { display: none; }
  .nn-note { bottom: 56px; color: #f2c46b; }
`;

/** Minimal HUD: loading bar while the world streams in, permanent data attribution, control hints. */
export class Hud {
  private readonly bar: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly note: HTMLDivElement;
  private noteTimer = 0;
  private readonly loading: HTMLDivElement;
  private readonly attribution: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.loading = el('div', 'nn-loading', root);
    el('div', 'nn-loading-label', this.loading).textContent = 'Nippes lädt …';
    this.bar = el('div', 'nn-loading-fill', el('div', 'nn-loading-track', this.loading));
    this.status = el('div', 'nn-loading-status', this.loading);
    el('div', 'nn-loading-controls', this.loading).textContent = CONTROLS_HINT;
    this.attribution = el('div', 'nn-attribution', root);
    this.hint = el('div', 'nn-hint', root);
    this.note = el('div', 'nn-note', root);
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.append(style);
  }

  /** p in 0..1 */
  setProgress(p: number): void {
    this.bar.style.width = `${Math.round(Math.min(Math.max(p, 0), 1) * 100)}%`;
  }

  /** Short line under the bar: what is being loaded right now. */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  hideLoading(): void {
    this.loading.classList.add('nn-hidden');
  }

  /** Replaces the loading bar with a visible error line. */
  showError(text: string): void {
    this.loading.replaceChildren(text);
    this.loading.classList.add('nn-error');
  }

  /** Persistent hint at the bottom centre; '' hides it. */
  setHint(text: string): void {
    this.hint.textContent = text;
  }

  /** Short message above the hint, gone after 2 s. */
  flash(text: string): void {
    this.note.textContent = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.note.textContent = ''; }, 2000);
  }

  setAttribution(text: string): void {
    this.attribution.textContent = text;
  }
}

function el(tag: 'div', cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.append(e);
  return e;
}
