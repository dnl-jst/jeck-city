import { CHAT_BAD_WORDS } from './badwords';
import { normaliseForFilter } from './names';

export { CHAT_BAD_WORDS };

export type ChatChannel = 's' | 'w';
/** Client → server. */
export type ChatSend = { c: ChatChannel; t: string };
/** Server → client; system lines use `slot` -1 and an empty name. */
export type ChatLineMsg = { c: ChatChannel | 'sys'; slot: number; name: string; t: string };

export const CHAT_MAX_LEN = 120;
export const CHAT_MAX_BYTES = 400;
export const SAY_RANGE_M = 50;
const SEND_MAX_RAW = 1000;

export const CHAT_TEXTS = {
  slow: 'Nicht so schnell.',
  unheard: 'Niemand in der Nähe hat dich gehört – /w für den Weltchat.',
} as const;

/** Limit to CHAT_MAX_LEN code points, then to CHAT_MAX_BYTES UTF-8 bytes at code point boundaries. */
export function clampChat(text: string): string {
  const out: string[] = [];
  let bytes = 0;
  for (const ch of text) {
    if (out.length >= CHAT_MAX_LEN) break;
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > CHAT_MAX_BYTES) break;
    bytes += b;
    out.push(ch);
  }
  return out.join('');
}

/** Server-authoritative chat text cleanup (NFC, no control/invisible chars, single spaces, clamped). */
export function checkChat(raw: string): { ok: true; text: string } | { ok: false } {
  const text = String(raw)
    .normalize('NFC')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\p{Cf}\p{Cc}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return { ok: false };
  return { ok: true, text: clampChat(text) };
}

/** Masks every whitespace-delimited chunk containing a bad word with asterisks. */
export function censorChat(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part)) return part;
      const n = normaliseForFilter(part);
      return CHAT_BAD_WORDS.some((w) => n.includes(w)) ? '*'.repeat([...part].length) : part;
    })
    .join('');
}

/** Shape check for an incoming chat message; returns null when malformed. */
export function parseChatSend(msg: unknown): ChatSend | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const { c, t } = msg as Record<string, unknown>;
  if (c !== 's' && c !== 'w') return null;
  if (typeof t !== 'string' || t.length > SEND_MAX_RAW) return null;
  return { c, t };
}
