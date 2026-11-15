/** Minimal HUD: loading bar while the world streams in, permanent data attribution. */
export class Hud {
  private readonly bar: HTMLDivElement;
  private readonly loading: HTMLDivElement;
  private readonly attribution: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.loading = el('div', 'nn-loading', root);
    el('div', 'nn-loading-label', this.loading).textContent = 'Nippes lädt …';
    this.bar = el('div', 'nn-loading-fill', el('div', 'nn-loading-track', this.loading));
    this.attribution = el('div', 'nn-attribution', root);
    const style = document.createElement('style');
    style.textContent = `
      .nn-loading { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(320px, 70vw);
        color: #e8ecf8; font: 15px/1.4 system-ui, sans-serif; letter-spacing: 0.05em; text-align: center; transition: opacity 0.6s; }
      .nn-loading-track { margin-top: 10px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.18); overflow: hidden; }
      .nn-loading-fill { height: 100%; width: 0; background: #f2c46b; transition: width 0.15s; }
      .nn-attribution { position: fixed; right: 8px; bottom: 6px; color: rgba(255,255,255,0.85);
        font: 11px/1.3 system-ui, sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,0.8); pointer-events: none; }
    `;
    document.head.append(style);
  }

  /** p in 0..1 */
  setProgress(p: number): void {
    this.bar.style.width = `${Math.round(Math.min(Math.max(p, 0), 1) * 100)}%`;
  }

  hideLoading(): void {
    this.loading.style.opacity = '0';
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
