import { checkChat, type ChatChannel } from '@nn/shared';

export type ChatLine = { c: ChatChannel | 'sys'; slot: number; name: string; text: string; at: number };

export const CHANNEL_LABEL: Record<ChatChannel, string> = { s: 'Sagen', w: 'Welt' };

const PREFIX = new Map<string, ChatChannel>([
  ['w', 'w'],
  ['welt', 'w'],
  ['s', 's'],
  ['sagen', 's'],
]);

/** Rolling chat history with an unread flag and change subscribers. */
export class ChatLog {
  private buf: ChatLine[] = [];
  private subs = new Set<() => void>();
  unread = false;

  constructor(private readonly cap = 50) {}

  get lines(): readonly ChatLine[] {
    return this.buf;
  }

  push(l: ChatLine): void {
    this.buf.push(l);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
    this.unread = true;
    for (const cb of [...this.subs]) cb();
  }

  markRead(): void {
    this.unread = false;
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

/** Input placeholder per channel (German). `hints`: with the slash hints (desktop), without on the mobile sheet (it has tabs). */
export function channelPlaceholder(c: ChatChannel, hints: boolean): string {
  if (c === 's') return `Sagen: hören alle in der Nähe${hints ? ' · /w für Welt' : ''}`;
  return `Welt: lesen alle im Spiel${hints ? ' · /s für Sagen' : ''}`;
}

/** A leading "/w ", "/welt ", "/s " or "/sagen " (any case, space required): the channel and the rest of the input. */
export function takeChannelPrefix(raw: string): { channel: ChatChannel; rest: string } | null {
  const m = /^\s*\/(\S+) ([\s\S]*)$/.exec(raw);
  const channel = m ? PREFIX.get((m[1] ?? '').toLowerCase()) : undefined;
  return m && channel ? { channel, rest: m[2] ?? '' } : null;
}

/** Splits an optional /w, /welt, /s, /sagen prefix off the input; text is null when nothing sendable remains. */
export function parseChatInput(raw: string, current: ChatChannel): { channel: ChatChannel; text: string | null } {
  const m = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
  const channel = m ? PREFIX.get((m[1] ?? '').toLowerCase()) : undefined;
  const body = m && channel ? (m[2] ?? '') : raw;
  const res = checkChat(body);
  return { channel: channel ?? current, text: res.ok ? res.text : null };
}

export function formatLine(l: ChatLine): string {
  if (l.c === 'sys') return l.text;
  return l.c === 'w' ? `[${CHANNEL_LABEL.w}] ${l.name}: ${l.text}` : `${l.name}: ${l.text}`;
}
