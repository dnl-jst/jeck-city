import type { ChatChannel } from '@nn/shared';
import type { Connection } from '../net/connection';
import type { TouchControls } from '../touch';
import { ChatLog } from './chat-log';
import { ChatSheet } from './chat-sheet';
import { ChatWindow } from './chat-window';

/**
 * Online chat: incoming lines into the log, the desktop window and the mobile sheet (sharing the channel), the touch
 * button's unread dot. `onSay` gets every say line (the sender's own too) for the speech bubbles.
 */
export class ChatController {
  readonly log = new ChatLog();
  onSay: ((slot: number, text: string) => void) | null = null;
  /** Called whenever the window or the sheet opens (the game lets go of held keys). */
  onOpen: (() => void) | null = null;
  private readonly window: ChatWindow;
  private readonly sheet: ChatSheet;
  private readonly touch: TouchControls;

  constructor(conn: Connection, opts: { root: HTMLElement; touch: TouchControls; touchOn: boolean; me: number }) {
    const send = (c: ChatChannel, text: string): void => {
      // the window and the sheet share the channel
      this.window.channel = this.sheet.channel = c;
      conn.sendChat(c, text);
    };
    this.window = new ChatWindow(opts.root, this.log, send);
    // on the body, not in the touch overlay: the overlay is hidden while the sheet is open
    this.sheet = new ChatSheet(document.body, this.log, send);
    conn.onChat((m) => {
      this.log.push({ c: m.c, slot: m.slot, name: m.name, text: m.t, at: Date.now() });
      if (m.c === 's') this.onSay?.(m.slot, m.t);
    });
    const touch = this.touch = opts.touch;
    touch.setChatAvailable(true);
    touch.onChat = () => this.sheet.open();
    this.sheet.onToggle = (open) => {
      touch.setSuspended(open);
      touch.setUnread(false);
      if (open) this.onOpen?.();
    };
    this.log.onChange(() => touch.setUnread(!this.sheet.isOpen && this.log.unread));
  }

  /** The desktop input or the mobile sheet is open (typing: no game keys). */
  get isOpen(): boolean {
    return this.window.isOpen || this.sheet.isOpen;
  }

  /** Enter: opens the window's input (a keyboard on a touch device: the sheet, the window is hidden there). */
  openInput(): void {
    if (this.isOpen) return;
    if (this.touch.enabled) {
      this.sheet.open();
      return;
    }
    this.window.open();
    this.onOpen?.();
  }

  tick(nowMs: number): void {
    this.window.tick(nowMs);
  }
}
