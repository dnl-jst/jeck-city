import { describe, expect, it } from 'vitest';
import { BAD_WORDS } from './badwords';
import { CHAT_BAD_WORDS, censorChat, checkChat, clampChat, parseChatSend } from './chat';

describe('checkChat', () => {
  it('collapses whitespace and trims', () => {
    expect(checkChat('  Hallo\n  Welt ')).toEqual({ ok: true, text: 'Hallo Welt' });
  });
  it('rejects empty or invisible-only input', () => {
    expect(checkChat('​ \t ')).toEqual({ ok: false });
    expect(checkChat('')).toEqual({ ok: false });
  });
  it('strips control characters', () => {
    expect(checkChat('a\u0007b')).toEqual({ ok: true, text: 'ab' });
  });
  it('clamps to 120 code points', () => {
    const r = checkChat('x'.repeat(200));
    expect(r.ok && [...r.text].length).toBe(120);
  });
});

describe('clampChat', () => {
  it('limits to 400 UTF-8 bytes at code point boundaries', () => {
    const r = clampChat('😀'.repeat(120));
    expect(new TextEncoder().encode(r).length).toBeLessThanOrEqual(400);
    expect([...r].every((c) => c === '😀')).toBe(true);
    expect([...r].length).toBe(100);
  });
});

describe('censorChat', () => {
  it('leaves harmless text alone', () => {
    expect(censorChat('scheißegal, shit happens')).toBe('scheißegal, shit happens');
    expect(censorChat('Marsch nach Kölsch')).toBe('Marsch nach Kölsch');
  });
  it('masks the whole offending chunk', () => {
    expect(censorChat('du Vollidioten!')).toBe('du ' + '*'.repeat(12));
    expect(censorChat('Hurens0hn')).toBe('*********');
  });
  it('preserves whitespace', () => {
    expect(censorChat('Arschlochkind  da')).toBe('*************  da');
  });
});

describe('parseChatSend', () => {
  it('accepts valid messages', () => {
    expect(parseChatSend({ c: 'w', t: 'hi' })).toEqual({ c: 'w', t: 'hi' });
  });
  it('rejects malformed messages', () => {
    expect(parseChatSend({ c: 'x', t: 'hi' })).toBeNull();
    expect(parseChatSend('hi')).toBeNull();
    expect(parseChatSend({ c: 's', t: 'a'.repeat(1001) })).toBeNull();
    expect(parseChatSend(null)).toBeNull();
  });
});

describe('CHAT_BAD_WORDS', () => {
  it('is a relaxed subset of BAD_WORDS', () => {
    expect(CHAT_BAD_WORDS).not.toContain('shit');
    expect(CHAT_BAD_WORDS).toContain('hurensohn');
    expect(BAD_WORDS).toContain('shit');
  });
});
