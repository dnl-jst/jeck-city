import { describe, expect, it, vi } from 'vitest';
import { CHANNEL_LABEL, ChatLog, channelPlaceholder, formatLine, parseChatInput, takeChannelPrefix, type ChatLine } from './chat-log';

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

describe('takeChannelPrefix', () => {
  it('takes a known prefix followed by a space, any case', () => {
    expect(takeChannelPrefix('/w ')).toEqual({ channel: 'w', rest: '' });
    expect(takeChannelPrefix('/Welt hallo')).toEqual({ channel: 'w', rest: 'hallo' });
    expect(takeChannelPrefix('/S hi du')).toEqual({ channel: 's', rest: 'hi du' });
    expect(takeChannelPrefix('/SAGEN x')).toEqual({ channel: 's', rest: 'x' });
  });

  it('waits for the space and ignores unknown or prototype names', () => {
    expect(takeChannelPrefix('/w')).toBeNull();
    expect(takeChannelPrefix('/wurst ')).toBeNull();
    expect(takeChannelPrefix('/constructor ')).toBeNull();
    expect(takeChannelPrefix('hallo /w ')).toBeNull();
  });
});

describe('channelPlaceholder', () => {
  it('explains the channel, with slash hints on the desktop only', () => {
    expect(channelPlaceholder('s', true)).toBe('Sagen: hören alle in der Nähe · /w für Welt');
    expect(channelPlaceholder('w', true)).toBe('Welt: lesen alle im Spiel · /s für Sagen');
    expect(channelPlaceholder('s', false)).toBe('Sagen: hören alle in der Nähe');
    expect(channelPlaceholder('w', false)).toBe('Welt: lesen alle im Spiel');
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
