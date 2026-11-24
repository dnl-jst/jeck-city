import type { Room } from '@colyseus/sdk';
import type { ChatLineMsg } from '@nn/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyJoinError, Connection } from './connection';

describe('classifyJoinError', () => {
  it('maps the server answers', () => {
    expect(classifyJoinError({ code: 409, message: 'version' })).toEqual({ kind: 'version' });
    expect(classifyJoinError({ code: 400, message: 'chars' })).toEqual({ kind: 'name', code: 'chars' });
    expect(classifyJoinError({ code: 429, message: 'rate' })).toEqual({ kind: 'rate' });
    expect(classifyJoinError({ code: 521, message: 'no rooms found' })).toEqual({ kind: 'full' });
  });

  it('treats everything else as unreachable', () => {
    expect(classifyJoinError(new TypeError('Failed to fetch'))).toEqual({ kind: 'unreachable' });
    expect(classifyJoinError({ code: 502, message: 'Bad Gateway' })).toEqual({ kind: 'unreachable' });
    expect(classifyJoinError({ code: 400, message: 'something else' })).toEqual({ kind: 'unreachable' });
    expect(classifyJoinError(undefined)).toEqual({ kind: 'unreachable' });
  });
});

describe('Connection chat', () => {
  beforeEach(() => { vi.stubGlobal('window', { setInterval: () => 0, setTimeout, clearTimeout }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function fakeRoom() {
    const handlers = new Map<string, (m: unknown) => void>();
    let drop = () => {};
    const send = vi.fn();
    const room = {
      onMessage: (t: string, cb: (m: unknown) => void) => { handlers.set(t, cb); },
      send,
      connection: { isOpen: true },
      reconnection: {},
      onDrop: (cb: () => void) => { drop = cb; },
      onReconnect: () => {}, onLeave: () => {}, onError: () => {},
      ping: () => {},
      leave: () => Promise.resolve(),
    } as unknown as Room;
    return { room, send, handlers, drop: () => drop() };
  }

  it('sends chat while online and drops it while reconnecting', () => {
    const f = fakeRoom();
    const conn = new Connection(f.room);
    conn.sendChat('w', 'hi');
    expect(f.send).toHaveBeenCalledWith('chat', { c: 'w', t: 'hi' });
    f.send.mockClear();
    f.drop();
    expect(conn.status).toBe('reconnecting');
    conn.sendChat('w', 'hi');
    expect(f.send).not.toHaveBeenCalled();
    conn.close();
  });

  it('delivers incoming chat lines to listeners', () => {
    const f = fakeRoom();
    const conn = new Connection(f.room);
    const got: ChatLineMsg[] = [];
    const off = conn.onChat((m) => got.push(m));
    const line: ChatLineMsg = { c: 's', slot: 2, name: 'Anna', t: 'moin' };
    f.handlers.get('chat')!(line);
    expect(got).toEqual([line]);
    off();
    f.handlers.get('chat')!(line);
    expect(got).toHaveLength(1);
  });
});
