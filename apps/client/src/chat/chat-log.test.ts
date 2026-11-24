import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_LABEL, ChatLog, formatLine, parseChatInput, type ChatLine } from './chat-log';

const line = (i: number, over: Partial<ChatLine> = {}): ChatLine => ({
  c: 's',
  slot: 0,
  name: 'Tünn',
  text: `m${i}`,
  at: i,
  ...over,
});

describe('parseChatInput', () => {
  it('switches channel with a prefix', () => {
    expect(parseChatInput('/w treffen am Dom?', 's')).toEqual({ channel: 'w', text: 'treffen am Dom?' });
    expect(parseChatInput('/WELT hi', 's')).toEqual({ channel: 'w', text: 'hi' });
    expect(parseChatInput('/sagen hi', 'w')).toEqual({ channel: 's', text: 'hi' });
  });

  it('prefix without text yields null text', () => {
    expect(parseChatInput('/s', 'w')).toEqual({ channel: 's', text: null });
  });

  it('keeps the current channel without prefix', () => {
    expect(parseChatInput('hi', 'w')).toEqual({ channel: 'w', text: 'hi' });
  });

  it('treats unknown slash commands as plain text', () => {
    expect(parseChatInput('/wurst ist lecker', 's')).toEqual({ channel: 's', text: '/wurst ist lecker' });
  });

  it('does not treat Object.prototype names as commands', () => {
    expect(parseChatInput('/constructor x', 's')).toEqual({ channel: 's', text: '/constructor x' });
    expect(parseChatInput('/toString', 'w')).toEqual({ channel: 'w', text: '/toString' });
  });

  it('rejects blank input', () => {
    expect(parseChatInput('   ', 's')).toEqual({ channel: 's', text: null });
  });
});

describe('ChatLog', () => {
  it('caps the history and drops the oldest lines', () => {
    const log = new ChatLog(50);
    for (let i = 0; i < 55; i++) log.push(line(i));
    expect(log.lines.length).toBe(50);
    expect(log.lines[0]?.text).toBe('m5');
  });

  it('tracks unread and notifies on every push', () => {
    const log = new ChatLog();
    const cb = vi.fn();
    log.onChange(cb);
    expect(log.unread).toBe(false);
    log.push(line(1));
    log.push(line(2));
    expect(log.unread).toBe(true);
    expect(cb).toHaveBeenCalledTimes(2);
    log.markRead();
    expect(log.unread).toBe(false);
  });

  it('unsubscribes', () => {
    const log = new ChatLog();
    const cb = vi.fn();
    const off = log.onChange(cb);
    off();
    log.push(line(1));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('formatLine', () => {
  it('formats all channels', () => {
    expect(formatLine(line(0, { text: 'Hey!' }))).toBe('Tünn: Hey!');
    expect(formatLine(line(0, { c: 'w', name: 'Jupp', text: 'treffen am Dom?' }))).toBe('[Welt] Jupp: treffen am Dom?');
    expect(formatLine(line(0, { c: 'sys', slot: -1, name: '', text: 'Nicht so schnell.' }))).toBe('Nicht so schnell.');
    expect(CHANNEL_LABEL).toEqual({ s: 'Sagen', w: 'Welt' });
  });
});
