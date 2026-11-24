import { BAD_WORDS } from './badwords';

export type NameResult = { ok: true; name: string } | { ok: false; error: 'length' | 'chars' | 'bad' };

export const NAME_ERRORS: Record<'length' | 'chars' | 'bad', string> = {
  length: 'Der Name muss 2–20 Zeichen lang sein.',
  chars: "Erlaubt sind Buchstaben, Ziffern, Leerzeichen und - _ . '",
  bad: 'Bitte such dir einen anderen Namen aus.',
};

const MIN_LEN = 2;
const MAX_LEN = 20;
const ALLOWED = /^[\p{L}\p{N} \-_.']+$/u;
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Lowercase, umlauts → ae/oe/ue/ss, leetspeak undone, diacritics and non-letters dropped. */
export const normaliseForFilter = (name: string): string =>
  name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    .normalize('NFD')
    .replace(/[^a-z]/g, '');

export function isBadName(name: string): boolean {
  const n = normaliseForFilter(name);
  return BAD_WORDS.some((w) => n.includes(w));
}

/** Server-authoritative name check; returns the cleaned name (NFC, trimmed, single spaces). */
export function checkName(raw: string): NameResult {
  const name = String(raw)
    .normalize('NFC')
    .replace(/\p{Cf}/gu, '') // zero-width and other invisible format characters
    .replace(/\s+/gu, ' ')
    .trim();
  const len = [...name].length;
  if (len < MIN_LEN || len > MAX_LEN) return { ok: false, error: 'length' };
  if (!ALLOWED.test(name) || !/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: 'chars' };
  if (isBadName(name)) return { ok: false, error: 'bad' };
  return { ok: true, name };
}

/**
 * Case-insensitive de-duplication: "Jupp" taken → "Jupp 2", then "Jupp 3" … The result stays within MAX_LEN code
 * points: the name is shortened to make room for the number (and loses a space it then ends with).
 */
export function dedupeName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(name.toLowerCase())) return name;
  const chars = [...name];
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const c = `${chars.slice(0, MAX_LEN - suffix.length).join('').trimEnd()}${suffix}`;
    if (!used.has(c.toLowerCase())) return c;
  }
}
