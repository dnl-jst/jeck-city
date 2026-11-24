import { checkChat, type ChatChannel } from '@nn/shared';
import { CHANNEL_LABEL, formatLine, type ChatLog } from './chat-log';

const CSS = `
  .nn-chat-sheet { position: fixed; z-index: 28; left: 0; right: 0; top: env(safe-area-inset-top); height: 50%;
    box-sizing: border-box; padding: 6px calc(8px + env(safe-area-inset-right)) 6px calc(8px + env(safe-area-inset-left));
    display: none; flex-direction: column; gap: 6px; background: rgba(10,12,20,0.88); color: #fff;
    font: 14px/1.35 system-ui, sans-serif; border-bottom: 1px solid rgba(255,255,255,0.25); }
  .nn-chat-sheet.nn-chat-sheet-open { display: flex; }
  .nn-chat-sheet-head { display: flex; align-items: center; gap: 6px; }
  .nn-chat-sheet-tab, .nn-chat-sheet-close, .nn-chat-sheet-send { font: inherit; color: #fff; cursor: pointer;
    background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25); border-radius: 6px; padding: 6px 12px;
    -webkit-tap-highlight-color: transparent; }
  .nn-chat-sheet-tab.nn-chat-sheet-active { background: rgba(242,196,107,0.35); border-color: #f2c46b; }
  .nn-chat-sheet-close { margin-left: auto; min-width: 40px; }
  .nn-chat-sheet-lines { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
    touch-action: pan-y; user-select: text; }
  .nn-chat-sheet-lines .nn-chat-line { overflow-wrap: anywhere; padding: 1px 0; }
  .nn-chat-sheet-lines .nn-chat-line.nn-chat-w { color: #f2c46b; }
  .nn-chat-sheet-lines .nn-chat-line.nn-chat-sys { color: rgba(255,255,255,0.6); font-style: italic; }
  .nn-chat-sheet-row { display: flex; gap: 6px; }
  .nn-chat-sheet-input { flex: 1; min-width: 0; font-size: 16px; /* 16px: iOS does not zoom into the field */ color: #fff;
    background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.3); border-radius: 6px; padding: 6px 8px; outline: none; }`;

/** Mobile chat: a sheet over the upper half of the screen with the log, channel tabs and an input. */
export class ChatSheet {
  channel: ChatChannel = 's';
  onToggle: ((open: boolean) => void) | null = null;
  private opened = false;
  private readonly el = document.createElement('div');
  private readonly linesEl = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly tabs = new Map<ChatChannel, HTMLButtonElement>();

  constructor(
    root: HTMLElement,
    private readonly log: ChatLog,
    private readonly send: (c: ChatChannel, text: string) => void,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    this.el.className = 'nn-chat-sheet';
    const head = document.createElement('div');
    head.className = 'nn-chat-sheet-head';
    for (const c of ['s', 'w'] as const) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'nn-chat-sheet-tab';
      tab.textContent = CHANNEL_LABEL[c];
      tab.addEventListener('click', () => {
        this.channel = c;
        this.renderTabs();
      });
      this.tabs.set(c, tab);
      head.append(tab);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'nn-chat-sheet-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Schließen');
    close.addEventListener('click', () => this.close());
    head.append(close);

    this.linesEl.className = 'nn-chat-sheet-lines';
    const row = document.createElement('div');
    row.className = 'nn-chat-sheet-row';
    this.input.className = 'nn-chat-sheet-input';
    this.input.type = 'text';
    this.input.maxLength = 120;
    this.input.autocomplete = 'off';
    this.input.enterKeyHint = 'send';
    this.input.setAttribute('enterkeyhint', 'send');
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'nn-chat-sheet-send';
    sendBtn.textContent = 'Senden';
    sendBtn.addEventListener('click', () => this.submit());
    row.append(this.input, sendBtn);

    this.el.append(head, this.linesEl, row);
    root.append(this.el);

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat || e.isComposing) return;
      this.submit();
    });
    this.log.onChange(() => {
      if (this.opened) {
        this.log.markRead();
        this.renderLines();
      }
    });
    this.renderTabs();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.log.markRead();
    document.exitPointerLock?.();
    this.el.classList.add('nn-chat-sheet-open');
    this.renderTabs();
    this.renderLines();
    this.input.focus();
    this.onToggle?.(true);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.input.value = '';
    this.input.blur();
    this.el.classList.remove('nn-chat-sheet-open');
    this.onToggle?.(false);
  }

  private submit(): void {
    const res = checkChat(this.input.value);
    if (!res.ok) return;
    this.send(this.channel, res.text);
    this.input.value = '';
  }

  private renderTabs(): void {
    for (const [c, tab] of this.tabs) tab.classList.toggle('nn-chat-sheet-active', c === this.channel);
  }

  private renderLines(): void {
    this.linesEl.replaceChildren(
      ...this.log.lines.map((l) => {
        const d = document.createElement('div');
        d.className = `nn-chat-line${l.c === 'w' ? ' nn-chat-w' : l.c === 'sys' ? ' nn-chat-sys' : ''}`;
        d.textContent = formatLine(l);
        return d;
      }),
    );
    this.linesEl.scrollTop = this.linesEl.scrollHeight;
  }
}
