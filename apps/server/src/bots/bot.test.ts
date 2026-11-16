import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeInputs, MAX_INPUTS_PER_PACKET, TICK_HZ, type InputPacket } from '@nn/shared';
import { Bot, type BotOptions, type BotRoom } from './bot';

/** Records what a bot sends; handlers registered by the bot can be fed by the test. */
function fakeRoom() {
  const packets: { atMs: number; p: InputPacket }[] = [];
  const sent: { type: string; msg: unknown }[] = [];
  const handlers = new Map<string, (m: unknown) => void>();
  const room: BotRoom = {
    send: (type, msg) => { sent.push({ type, msg }); },
    sendBytes: (type, bytes) => {
      expect(type).toBe('i');
      const p = decodeInputs(bytes);
      expect(p).not.toBeNull();
      packets.push({ atMs: Date.now(), p: p! });
    },
    onMessage: (type, cb) => { handlers.set(type, cb as (m: unknown) => void); },
  };
  return { room, packets, sent, handlers };
}

const opts = (over: Partial<BotOptions> = {}): BotOptions => ({
  role: 'walk', seed: 7, home: { x: 0, z: 0 }, start: { x: 10, z: 5 }, vehicles: [], now: () => Date.now(), ...over,
});

describe('Bot', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('bot sends ≤ 20 packets/s of ≤ 3 inputs', () => {
    const { room, packets } = fakeRoom();
    const bot = new Bot(room, opts());
    const t0 = Date.now();
    bot.start();
    vi.advanceTimersByTime(10_000);
    bot.stop();

    expect(packets.length).toBeGreaterThan(0);
    for (const { p } of packets) {
      expect(p.inputs.length).toBeGreaterThanOrEqual(1);
      expect(p.inputs.length).toBeLessThanOrEqual(MAX_INPUTS_PER_PACKET);
    }
    // per second: at most 20 packets, about 60 inputs
    for (let s = 0; s < 10; s++) {
      const inSecond = packets.filter(({ atMs }) => atMs - t0 >= s * 1000 && atMs - t0 < (s + 1) * 1000);
      expect(inSecond.length).toBeLessThanOrEqual(20);
      const inputs = inSecond.reduce((n, { p }) => n + p.inputs.length, 0);
      expect(inputs).toBeGreaterThanOrEqual(TICK_HZ - 3);
      expect(inputs).toBeLessThanOrEqual(TICK_HZ);
    }
    // seqs follow on without gaps
    for (let i = 1; i < packets.length; i++) {
      const a = packets[i - 1]!.p, b = packets[i]!.p;
      expect(b.seq).toBe(a.seq + a.inputs.length);
    }
  });

  it('a late timer is caught up in packets of ≤ 3, the backlog beyond two packets is skipped', () => {
    let now = 0;
    const { room, packets } = fakeRoom();
    const bot = new Bot(room, opts({ now: () => now }));
    bot.start();
    now = 1000; // the event loop stalled for a second
    vi.advanceTimersByTime(50);
    bot.stop();
    expect(packets.length).toBe(2);
    expect(packets.every(({ p }) => p.inputs.length === MAX_INPUTS_PER_PACKET)).toBe(true);
  });

  it('teleports to its start, and the same seed gives the same inputs', () => {
    const run = () => {
      const { room, packets, sent } = fakeRoom();
      const bot = new Bot(room, opts({ seed: 42 }));
      bot.start();
      vi.advanceTimersByTime(20_000);
      bot.stop();
      return { inputs: packets.flatMap(({ p }) => p.inputs), sent };
    };
    const a = run(), b = run();
    expect(a.sent[0]).toEqual({ type: 'devTeleport', msg: { x: 10, z: 5 } });
    expect(a.inputs).toEqual(b.inputs);
    // a walker walks and picks new targets now and then
    expect(a.inputs.every((i) => i.forward === 1)).toBe(true);
    expect(new Set(a.inputs.map((i) => i.yaw.toFixed(3))).size).toBeGreaterThan(1);
  });

  it('a driver teleports next to a car and presses E until the snapshot says it drives', () => {
    const { room, packets, sent } = fakeRoom();
    const bot = new Bot(room, opts({ role: 'drive', vehicles: [{ x: 100, z: 50, heading: 0 }] }));
    bot.start();
    vi.advanceTimersByTime(3000);
    bot.stop();
    const tp = sent.find((s) => s.type === 'devTeleport')!.msg as { x: number; z: number };
    expect(Math.hypot(tp.x - 100, tp.z - 50)).toBeLessThan(3);
    const uses = packets.flatMap(({ p }) => p.inputs).filter((i) => i.use).length;
    expect(uses).toBeGreaterThanOrEqual(2);
  });

  it('counts received bytes per second', () => {
    let now = 0;
    const { room } = fakeRoom();
    const bot = new Bot(room, opts({ now: () => now }));
    bot.received(1000);
    now = 500;
    bot.received(500);
    now = 1200;
    bot.received(300);
    now = 3100;
    bot.received(10);
    expect(bot.bytesPerSecond()).toEqual([1500, 300, 0]);
  });
});
