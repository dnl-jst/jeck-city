import type { ChatChannel } from '@nn/shared';
import { CHANNEL_LABEL, formatLine, parseChatInput, type ChatLog } from './chat-log';

const VISIBLE_MS = 15_000;
const SHOWN_LINES = 8;

/** The window shows while the input is open or for 15 s after the last activity. */
export function windowVisible(lastActivityMs: number, nowMs: number, open: boolean): boolean {
  return open || nowMs - lastActivityMs < VISIBLE_MS;
}

const CSS = `
  .nn-chat { position: fixed; z-index: 27; left: calc(8px + env(safe-area-inset-left)); bottom: 24px;
    width: min(360px, 60vw); padding: 4px 6px; box-sizing: border-box; border-radius: 4px;
    font: 13px/1.35 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    pointer-events: none; user-select: none; display: none; }
  .nn-chat.nn-chat-open { background: rgba(10,12,20,0.45); }
  .nn-chat-line { overflow-wrap: anywhere; }
  .nn-chat-line.nn-chat-w { color: #f2c46b; }
  .nn-chat-line.nn-chat-sys { color: rgba(255,255,255,0.6); font-style: italic; }
  .nn-chat-row { display: none; align-items: center; gap: 6px; margin-top: 4px; }
  .nn-chat-open .nn-chat-row { display: flex; }
  .nn-chat-prefix { white-space: nowrap; opacity: 0.85; }
  .nn-chat-input { flex: 1; min-width: 0; pointer-events: auto; user-select: text; font: inherit; color: #fff;
    background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.25); border-radius: 3px; padding: 2px 5px; outline: none; }
  body.nn-touch .nn-chat { display: none !important; }`;

/** Desktop chat window: the last lines of the log plus an input row that is only shown while open. */
export class ChatWindow {
  channel: ChatChannel = 's';
  private opened = false;
  private lastActivity = 0;
  private readonly el = document.createElement('div');
  private readonly linesEl = document.createElement('div');
  private readonly prefix = document.createElement('span');
  private readonly input = document.createElement('input');

  constructor(
    root: HTMLElement,
    private readonly log: ChatLog,
    private readonly send: (c: ChatChannel, text: string) => void,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    this.el.className = 'nn-chat';
    this.linesEl.className = 'nn-chat-lines';
    const row = document.createElement('div');
    row.className = 'nn-chat-row';
    this.prefix.className = 'nn-chat-prefix';
    this.input.className = 'nn-chat-input';
    this.input.type = 'text';
    this.input.maxLength = 120;
    this.input.autocomplete = 'off';
    row.append(this.prefix, this.input);
    this.el.append(this.linesEl, row);
    root.append(this.el);

    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.log.onChange(() => {
      this.lastActivity = performance.now();
      this.render();
    });
    this.render();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.lastActivity = performance.now();
    this.log.markRead();
    document.exitPointerLock();
    this.input.value = '';
    this.render();
    this.input.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.lastActivity = performance.now();
    this.input.value = '';
    this.input.blur();
    this.render();
  }

  tick(nowMs: number): void {
    this.el.style.display = windowVisible(this.lastActivity, nowMs, this.opened) ? 'block' : 'none';
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.submit();
    }
  }

  private submit(): void {
    const parsed = parseChatInput(this.input.value, this.channel);
    this.channel = parsed.channel;
    if (parsed.text !== null) {
      this.send(parsed.channel, parsed.text);
      this.close();
    } else if (this.input.value.trim() === '') {
      this.close();
    } else {
      // Only a channel switch (e.g. "/w"): keep the input open.
      this.input.value = '';
      this.render();
    }
  }

  private render(): void {
    this.el.classList.toggle('nn-chat-open', this.opened);
    this.prefix.textContent = `${CHANNEL_LABEL[this.channel]} ▸`;
    this.linesEl.replaceChildren(
      ...this.log.lines.slice(-SHOWN_LINES).map((l) => {
        const d = document.createElement('div');
        d.className = `nn-chat-line${l.c === 'w' ? ' nn-chat-w' : l.c === 'sys' ? ' nn-chat-sys' : ''}`;
        d.textContent = formatLine(l);
        return d;
      }),
    );
  }
}
