import { FetchError, NoWebGLError } from './errors';

/** User-facing (German) text for a boot failure. */
export function bootErrorMessage(e: unknown): string {
  if (e instanceof NoWebGLError) return 'Dein Browser kann leider kein 3D (WebGL). Probier es mit einem aktuellen Chrome, Firefox oder Safari.';
  if (e instanceof FetchError) return 'Nippes konnte nicht geladen werden. Bitte lade die Seite neu.';
  return 'Da ist was schiefgelaufen. Bitte lade die Seite neu.';
}

export const CONTROLS_HINT = 'WASD laufen · Shift rennen · Leertaste springen · E ein-/aussteigen · R Radio · N Ton · M Karte · Maus umsehen (klicken)';

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
  .nn-wheel { position: fixed; left: 50%; top: 50%; width: min(340px, 80vmin); aspect-ratio: 1; pointer-events: none;
    transform: translate(-50%, -50%) scale(0.86); opacity: 0; visibility: hidden;
    transition: opacity 0.14s ease-out, transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.25), visibility 0s 0.18s;
    font: 600 clamp(10px, 3.4vmin, 13px)/1.2 system-ui, sans-serif; color: #fff; letter-spacing: 0.02em; }
  .nn-wheel.nn-open { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); transition-delay: 0s; }
  .nn-wheel-disc { position: absolute; inset: 0; border-radius: 50%; border: 1px solid rgba(242,196,107,0.35);
    background: repeating-conic-gradient(from 45deg, rgba(255,255,255,0.16) 0 0.5deg, transparent 0.5deg 90deg),
      radial-gradient(circle, rgba(24,28,44,0.72) 0 30%, rgba(10,12,20,0.6) 31% 100%);
    backdrop-filter: blur(6px); box-shadow: 0 10px 40px rgba(0,0,0,0.55), inset 0 0 30px rgba(0,0,0,0.5); }
  .nn-wheel-sector { position: absolute; inset: 0; border-radius: 50%; transform: rotate(var(--nn-sector, 0deg));
    background: conic-gradient(from -45deg, rgba(242,196,107,0.32), rgba(242,196,107,0.14) 90deg, transparent 90deg);
    -webkit-mask: radial-gradient(circle, transparent 30%, #000 30.5%); mask: radial-gradient(circle, transparent 30%, #000 30.5%); }
  .nn-wheel-slot { position: absolute; width: 34%; display: flex; flex-direction: column; align-items: center; gap: 4px;
    transform: translate(-50%, -50%); opacity: 0.72; transition: transform 0.12s, opacity 0.12s; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  .nn-wheel-slot-0 { left: 50%; top: 19%; } .nn-wheel-slot-1 { left: 80%; top: 50%; }
  .nn-wheel-slot-2 { left: 50%; top: 81%; } .nn-wheel-slot-3 { left: 20%; top: 50%; }
  .nn-wheel-logo { width: 62%; aspect-ratio: 1; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6)); transition: filter 0.12s; }
  .nn-wheel-logo svg { display: block; width: 100%; height: 100%; }
  .nn-wheel-name { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  .nn-wheel-dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: #f2c46b; box-shadow: 0 0 6px #f2c46b; }
  .nn-wheel-slot.nn-on .nn-wheel-dot { display: block; }
  .nn-wheel-slot.nn-hl { opacity: 1; transform: translate(-50%, -50%) scale(1.14); color: #f2c46b; }
  .nn-wheel-slot.nn-hl .nn-wheel-logo { filter: drop-shadow(0 0 4px rgba(242,196,107,0.9)) drop-shadow(0 0 14px rgba(242,196,107,0.55)); }
  .nn-wheel-hub { position: absolute; left: 50%; top: 50%; width: 30%; aspect-ratio: 1; transform: translate(-50%, -50%);
    border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
    background: rgba(10,12,20,0.75); border: 1px solid rgba(242,196,107,0.3); text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  .nn-wheel-title { font-size: 0.72em; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.6; }
  .nn-wheel-hub-name { margin-top: 2px; padding: 0 6px; color: #f2c46b; font-size: 0.92em; }
  .nn-minimap { position: fixed; right: 16px; top: 16px; width: 180px; pointer-events: none; font: 12px/1.3 system-ui, sans-serif; }
  .nn-minimap.nn-hidden { display: none; }
  .nn-minimap-disc { position: relative; width: 180px; height: 180px; border-radius: 50%; overflow: hidden;
    border: 2px solid rgba(242,196,107,0.55); box-shadow: 0 4px 18px rgba(0,0,0,0.6); background: #141a2b; }
  .nn-minimap-canvas { display: block; width: 180px; height: 180px; }
  .nn-minimap-north { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; text-align: center; font-weight: 700;
    font-size: 11px; line-height: 16px; color: #f2c46b; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  .nn-minimap-street { margin-top: 6px; text-align: center; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  .nn-minimap-street:empty { display: none; }
  .nn-bigmap { position: fixed; inset: 0; background: rgba(10,12,20,0.88); color: #fff; font: 13px/1.3 system-ui, sans-serif; }
  .nn-bigmap.nn-hidden { display: none; }
  .nn-bigmap-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .nn-bigmap-hint { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); padding: 4px 10px; border-radius: 12px;
    background: rgba(10,12,20,0.6); text-shadow: 0 1px 3px rgba(0,0,0,0.9); pointer-events: none; }
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
