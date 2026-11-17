import type { Weather } from '@nn/shared';

const ICON: Record<Weather['kind'], string> = {
  clear: '☀', cloudy: '☁', fog: '≋', drizzle: '☂', rain: '☂', snow: '❄',
};

/** "☂ 7 °C · leichter Regen"; null while the weather is unknown. */
export function badgeText(w: Weather | null, night: boolean): string | null {
  if (!w || !w.known) return null;
  const icon = w.kind === 'clear' && night ? '☾' : ICON[w.kind];
  const t = Math.round(w.temperature);
  const temp = t < 0 ? `−${-t}` : `${t === 0 ? 0 : t}`;
  return `${icon} ${temp} °C · ${w.label}`;
}

const CSS = `
.nn-weather { position: fixed; left: 12px; top: 12px; z-index: 4; padding: 4px 10px; border-radius: 12px;
  background: rgba(10,12,20,0.45); color: #fff; font: 13px system-ui, sans-serif; pointer-events: none; white-space: nowrap; }
.nn-weather[hidden] { display: none; }
/* the debug overlay (?debug=1) occupies the top-left corner; sit below it */
body:has(.nn-debug) .nn-weather { top: 190px; }`;

/** Small weather badge in the top-left corner; own element so a HUD redesign can move it. */
export class WeatherBadge {
  private readonly el: HTMLDivElement;
  private text: string | null | undefined = undefined;

  constructor(root: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    this.el = document.createElement('div');
    this.el.className = 'nn-weather';
    this.el.hidden = true;
    root.append(style, this.el);
  }

  set(w: Weather | null, night: boolean): void {
    const text = badgeText(w, night);
    if (text === this.text) return;
    this.text = text;
    this.el.hidden = text === null;
    this.el.textContent = text ?? '';
  }
}
