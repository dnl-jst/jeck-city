import { TICK_HZ } from '@nn/shared';

/** Seconds until the announced restart (rounded up, never negative); null when none is announced. */
export function restartSecondsLeft(restartTick: number | undefined, serverTick: number): number | null {
  if (!restartTick) return null;
  return Math.max(0, Math.ceil((restartTick - serverTick) / TICK_HZ));
}

export function restartText(secondsLeft: number | null): string | null {
  if (secondsLeft === null) return null;
  if (secondsLeft <= 0) return 'Die Stadt wird aktualisiert – Neustart jetzt';
  const s = Math.floor(secondsLeft % 60);
  return `Die Stadt wird aktualisiert – Neustart in ${Math.floor(secondsLeft / 60)}:${s < 10 ? '0' : ''}${s}`;
}

const CSS = `
.nn-restart { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); z-index: 6; padding: 6px 14px;
  border-radius: 12px; background: rgba(10,12,20,0.75); color: #fff; font: 14px system-ui, sans-serif;
  pointer-events: none; white-space: nowrap; }
.nn-restart[hidden] { display: none; }
.nn-restart.nn-restart-soon { color: #f2c46b; font-weight: 700; }`;

/** Countdown banner at the top centre while the server has announced a restart. */
export class RestartBanner {
  private readonly el: HTMLDivElement;
  private text: string | null | undefined = undefined;
  private soon = false;

  constructor(root: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    this.el = document.createElement('div');
    this.el.className = 'nn-restart';
    this.el.hidden = true;
    root.append(style, this.el);
  }

  set(secondsLeft: number | null): void {
    const soon = secondsLeft !== null && secondsLeft <= 10;
    if (soon !== this.soon) {
      this.soon = soon;
      this.el.classList.toggle('nn-restart-soon', soon);
    }
    const text = restartText(secondsLeft);
    if (text === this.text) return;
    this.text = text;
    this.el.hidden = text === null;
    this.el.textContent = text ?? '';
  }
}
