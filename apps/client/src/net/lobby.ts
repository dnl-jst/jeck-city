import { checkName, NAME_ERRORS } from '@nn/shared';

const STORAGE_KEY = 'nn-name';

/** The error text for a name the player typed, or null when it is fine. The server checks again, binding. */
export function validate(raw: string): string | null {
  const r = checkName(raw);
  return r.ok ? null : NAME_ERRORS[r.error];
}

const LOBBY_CSS = `
  .nn-lobby { position: fixed; z-index: 10; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(8,10,22,0.82); backdrop-filter: blur(4px); color: #e8ecf8; font: 15px/1.4 system-ui, sans-serif; }
  .nn-lobby.nn-hidden { display: none; }
  .nn-lobby-box { width: min(340px, 86vw); text-align: center; }
  .nn-lobby-title { font-size: 22px; letter-spacing: 0.08em; margin-bottom: 16px; color: #f2c46b; }
  .nn-lobby-avatars { display: flex; justify-content: center; gap: 14px; margin-bottom: 16px; }
  .nn-lobby-avatar { width: 96px; height: 96px; padding: 0; border-radius: 50%; overflow: hidden; cursor: pointer;
    border: 2px solid rgba(255,255,255,0.18); background: radial-gradient(circle at 50% 35%, #2c3350, #141828 70%);
    opacity: 0.6; transition: opacity 0.15s, transform 0.15s, border-color 0.15s, box-shadow 0.15s; }
  .nn-lobby-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .nn-lobby-avatar:hover { opacity: 0.85; }
  .nn-lobby-avatar:focus-visible { outline: 2px solid #f2c46b; outline-offset: 3px; }
  .nn-lobby-avatar[aria-checked="true"] { opacity: 1; transform: scale(1.06); border-color: #f2c46b;
    box-shadow: 0 0 0 3px rgba(242,196,107,0.25), 0 6px 20px rgba(0,0,0,0.5); }
  .nn-lobby-avatar:disabled { cursor: default; }
  .nn-lobby-label { display: block; margin-bottom: 6px; font-size: 13px; opacity: 0.85; }
  .nn-lobby-input { box-sizing: border-box; width: 100%; padding: 10px 12px; font: inherit; font-size: 16px; color: #fff;
    background: rgba(255,255,255,0.1); border: 1px solid rgba(242,196,107,0.5); border-radius: 8px; outline: none; }
  .nn-lobby-input:focus { border-color: #f2c46b; box-shadow: 0 0 0 2px rgba(242,196,107,0.25); }
  .nn-lobby-input:disabled { opacity: 0.55; }
  .nn-lobby-go { margin-top: 12px; padding: 9px 22px; font: inherit; color: #1a1408; background: #f2c46b; border: 0;
    border-radius: 8px; cursor: pointer; }
  .nn-lobby-go:disabled { opacity: 0.4; cursor: default; }
  .nn-lobby-msg { min-height: 2.8em; margin-top: 12px; font-size: 13px; }
  .nn-lobby-msg.nn-err { color: #ffb4a8; }
  .nn-lobby-retry { display: block; margin-top: 2px; opacity: 0.8; }
  .nn-lobby-dl { margin-top: 8px; font-size: 12px; opacity: 0.75; font-variant-numeric: tabular-nums; }
  .nn-lobby-dl[hidden] { display: none; }
  .nn-lobby-dl-track { margin-bottom: 6px; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.15); overflow: hidden; }
  .nn-lobby-dl-fill { height: 100%; width: 0; background: #f2c46b; transition: width 0.25s; }
`;

/** The name dialog (DOM overlay) that stays up as the connection status while joining. */
export class Lobby {
  private readonly root: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private readonly msg: HTMLDivElement;
  private readonly dl: HTMLDivElement;
  private readonly dlFill: HTMLDivElement;
  private readonly dlText: HTMLDivElement;
  private readonly avatars: HTMLButtonElement[] = [];
  private chosen: number;
  private countdown = 0;
  private submit: ((name: string) => void) | null = null;

  /**
   * portraits: image URL per selectable figure (index = character variant), `chosen` preselected. The figures carry no
   * labels beyond "Figur n": the portrait is the choice.
   */
  constructor(parent: HTMLElement, portraits: readonly string[] = [], chosen = 0) {
    const style = document.createElement('style');
    style.textContent = LOBBY_CSS;
    document.head.append(style);
    this.root = div('nn-lobby nn-hidden', parent);
    const box = div('nn-lobby-box', this.root);
    div('nn-lobby-title', box).textContent = 'Nippes Nights';
    this.chosen = Math.min(Math.max(chosen, 0), Math.max(portraits.length - 1, 0));
    if (portraits.length > 1) {
      const row = div('nn-lobby-avatars', box);
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', 'Deine Figur');
      portraits.forEach((url, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nn-lobby-avatar';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', `Figur ${i + 1}`);
        b.title = `Figur ${i + 1}`;
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.draggable = false;
        b.append(img);
        b.addEventListener('click', () => this.pick(i, false));
        // arrows move the choice; the game's key handlers on window must not see these keys
        b.addEventListener('keydown', (e) => {
          e.stopPropagation();
          const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (step) {
            e.preventDefault();
            this.pick((this.chosen + step + portraits.length) % portraits.length, true);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            this.confirm();
          }
        });
        b.addEventListener('keyup', (e) => e.stopPropagation());
        row.append(b);
        this.avatars.push(b);
      });
      this.pick(this.chosen, false);
    }
    const label = document.createElement('label');
    label.className = 'nn-lobby-label';
    label.textContent = 'Wie heißt du?';
    this.input = document.createElement('input');
    this.input.className = 'nn-lobby-input';
    this.input.type = 'text';
    this.input.maxLength = 40;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    label.append(document.createElement('br'), this.input);
    box.append(label);
    this.button = document.createElement('button');
    this.button.className = 'nn-lobby-go';
    this.button.textContent = 'Los';
    box.append(this.button);
    this.msg = div('nn-lobby-msg', box);
    this.dl = div('nn-lobby-dl', box);
    this.dl.hidden = true;
    this.dlFill = div('nn-lobby-dl-fill', div('nn-lobby-dl-track', this.dl));
    this.dlText = div('nn-lobby-dl-text', this.dl);
    // the game's key handlers sit on window: they must neither see these keys nor swallow the space bar
    for (const type of ['keydown', 'keyup'] as const) this.input.addEventListener(type, (e) => e.stopPropagation());
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.confirm(); });
    this.input.addEventListener('input', () => this.clearMessage());
    this.button.addEventListener('click', () => this.confirm());
  }

  /** Shows the dialog; resolves with the cleaned name once the player confirms a valid one. Can be asked again. */
  ask(): Promise<string> {
    this.stopCountdown();
    this.root.classList.remove('nn-hidden');
    this.setBusy(false);
    this.input.value = this.input.value || recall();
    this.input.focus();
    this.input.select();
    return new Promise((resolve) => { this.submit = resolve; });
  }

  /** Shows a status line (e.g. "Verbinde …") and locks the field while the connection is being made. */
  showStatus(text: string): void {
    this.stopCountdown();
    this.root.classList.remove('nn-hidden');
    this.setBusy(true);
    this.setMessage(text, false);
  }

  /**
   * Shows an error under the field. With retryInS it also counts down to the next automatic attempt (display only:
   * the caller does the retrying) and the field stays locked; without, the player can edit the name again via ask().
   */
  showError(text: string, retryInS?: number): void {
    this.stopCountdown();
    this.root.classList.remove('nn-hidden');
    this.setMessage(text, true);
    if (retryInS === undefined) return;
    this.setBusy(true);
    const retry = document.createElement('span');
    retry.className = 'nn-lobby-retry';
    this.msg.append(retry);
    let left = Math.ceil(retryInS);
    const tick = (): void => { retry.textContent = `Neuer Versuch in ${left} s`; };
    tick();
    this.countdown = window.setInterval(() => { if (left > 0) left--; tick(); }, 1000);
  }

  /** The world still downloading behind the dialog: progress 0..1 and a line like "24,6 MB von 103 MB · 3,1 MB/s". */
  setDownload(progress: number, text: string): void {
    this.dl.hidden = false;
    this.dlFill.style.width = `${(Math.min(Math.max(progress, 0), 1) * 100).toFixed(1)}%`;
    this.dlText.textContent = `Lädt im Hintergrund: ${text}`;
  }

  close(): void {
    this.stopCountdown();
    this.root.classList.add('nn-hidden');
  }

  private confirm(): void {
    if (!this.submit) return;
    const err = validate(this.input.value);
    if (err) return this.setMessage(err, true);
    const r = checkName(this.input.value);
    if (!r.ok) return;
    remember(r.name);
    this.input.value = r.name;
    const done = this.submit;
    this.submit = null;
    this.setBusy(true);
    this.setMessage('', false);
    done(r.name);
  }

  /** The chosen figure (index into the portraits = character variant). */
  get variant(): number {
    return this.chosen;
  }

  private pick(i: number, focus: boolean): void {
    this.chosen = i;
    this.avatars.forEach((b, k) => {
      b.setAttribute('aria-checked', String(k === i));
      b.tabIndex = k === i ? 0 : -1; // one tab stop for the group, arrows move within it
    });
    if (focus) this.avatars[i]?.focus();
  }

  private setBusy(busy: boolean): void {
    this.input.disabled = busy;
    this.button.disabled = busy;
    for (const b of this.avatars) b.disabled = busy;
  }

  private setMessage(text: string, isError: boolean): void {
    this.msg.textContent = text;
    this.msg.classList.toggle('nn-err', isError);
  }

  private clearMessage(): void {
    this.setMessage('', false);
  }

  private stopCountdown(): void {
    clearInterval(this.countdown);
    this.countdown = 0;
  }
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.append(e);
  return e;
}

function recall(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function remember(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // private mode or blocked storage: the name just is not remembered
  }
}
