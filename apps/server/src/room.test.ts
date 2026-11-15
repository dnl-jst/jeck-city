import { existsSync, readFileSync } from 'node:fs';
import { Client, type Room } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeInputs, NEUTRAL_INPUT, PROTOCOL_VERSION, worldHash } from '@nn/shared';
import { loadConfig } from './config';
import { startServer, type RunningServer } from './server';

const cfg = loadConfig({}, { port: 0, maxPlayers: 2, logLevel: 'error', joinPerMin: 1000 });
const haveAssets = ['manifest.json', 'collision.bin', 'terrain.bin'].every((f) => existsSync(`${cfg.worldDir}/${f}`));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}

describe.skipIf(!haveAssets)('nippes room', () => {
  let srv: RunningServer;
  let hash: string;
  const open: Room[] = [];

  beforeAll(async () => {
    const m = readFileSync(`${cfg.worldDir}/manifest.json`);
    hash = await worldHash(m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength));
    srv = await startServer(cfg);
  }, 60_000);

  afterAll(async () => {
    await srv?.stop();
  });

  const client = () => new Client(`ws://127.0.0.1:${srv.port}`);
  const join = async (name: string, over: Record<string, unknown> = {}): Promise<Room> => {
    const r = await client().join('nippes', { name, protocolVersion: PROTOCOL_VERSION, worldHash: hash, ...over });
    open.push(r);
    return r;
  };
  /** Leaves all rooms opened so far and waits until the server has removed them. */
  const leaveAll = async () => {
    await Promise.all(open.splice(0).map((r) => r.leave().catch(() => 0)));
    await until(() => srv.room.clients.length === 0);
  };
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as { code: number; message: string };
    }
    throw new Error('join was accepted');
  };

  it('join gets a welcome with slot, name, devMode and tick', async () => {
    const welcome = new Promise<Record<string, unknown>>((resolve) => {
      void client()
        .join('nippes', { name: '  Jupp ', protocolVersion: PROTOCOL_VERSION, worldHash: hash })
        .then((r) => {
          open.push(r);
          r.onMessage('welcome', resolve);
        });
    });
    const w = await welcome;
    expect(w).toMatchObject({ slot: 0, name: 'Jupp', devMode: cfg.dev });
    expect(typeof w.tick).toBe('number');
    const b = await join('jupp');
    const wb = await new Promise<Record<string, unknown>>((resolve) => b.onMessage('welcome', resolve));
    expect(wb).toMatchObject({ slot: 1, name: 'jupp 2' });
    await until(() => (b.state as { players: Map<string, unknown> }).players.size === 2);
    await leaveAll();
  });

  it('join with wrong protocol → 409', async () => {
    const e = await rejection(join('Jupp', { protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(e.code).toBe(409);
    expect(e.message).toBe('version');
    const e2 = await rejection(join('Jupp', { worldHash: 'ffffffffffff' }));
    expect(e2.code).toBe(409);
  });

  it("bad name → 400 'bad'", async () => {
    const e = await rejection(join('Arschl0ch'));
    expect(e.code).toBe(400);
    expect(e.message).toBe('bad');
    expect((await rejection(join('x'))).message).toBe('length');
    expect((await rejection(join('a\u{1F600}b'))).message).toBe('chars');
    expect((await rejection(join(42 as unknown as string))).code).toBe(400);
  });

  it('101st player is rejected (maxPlayers 2: the third)', async () => {
    await join('Anna');
    await join('Bert');
    const e = await rejection(join('Carl'));
    expect(e.code).toBeGreaterThan(0);
    expect(srv.room.clients.length).toBe(2);
    await leaveAll();
    // a freed place can be taken again, lowest slot first
    const c = await join('Carl');
    const w = await new Promise<Record<string, unknown>>((resolve) => c.onMessage('welcome', resolve));
    expect(w.slot).toBe(0);
    await leaveAll();
  });

  it('flood and garbage do not crash the room', async () => {
    const b = await join('Bert');
    const names = () => {
      const players = (b.state as { players?: Map<string, { name: string }> }).players;
      return [...(players?.values() ?? [])].map((p) => p.name).sort();
    };

    // 500 inputs/s for one second, some with NaN/∞ axes and yaw, plus truncated garbage
    const a = await join('Anna');
    await until(() => names().length === 2);
    const tick0 = srv.room.sim.tick;
    let seq = 1;
    for (let n = 0; n < 50; n++) {
      // 10 inputs per 20 ms in packets of 3, 3, 3, 1 (5 messages per 20 ms with the garbage one)
      for (const count of [3, 3, 3, 1]) {
        const inputs = Array.from({ length: count }, (_, k) => ({
          ...NEUTRAL_INPUT(NaN), forward: k % 2 ? NaN : Infinity, right: -Infinity, use: true,
        }));
        a.sendBytes('i', encodeInputs({ seq, tick: 0, inputs }));
        seq += count;
      }
      a.sendBytes('i', n % 2 ? new Uint8Array([1, 2, 3]) : new Uint8Array(0));
      await sleep(20);
    }
    a.send('radio', { evil: true });
    a.send('devTeleport', { x: NaN, z: 'x' });
    await sleep(100);
    const q = srv.room.queueOf(a.sessionId)!;
    expect(q.accepted).toBeLessThanOrEqual(90 + 6 + 10);
    // the simulation kept ticking at about 60 Hz throughout
    expect(srv.room.sim.tick - tick0).toBeGreaterThan(50);
    const p = srv.room.sim.player(srv.room.slotOf(a.sessionId)!);
    expect(Number.isFinite(p.pos.x) && Number.isFinite(p.yaw)).toBe(true);

    // an oversized message (1 kB) disconnects with 4400
    const leftA = new Promise<number>((resolve) => a.onLeave(resolve));
    a.sendBytes('i', new Uint8Array(1024));
    expect(await leftA).toBe(4400);
    await until(() => names().length === 1);

    // a 10 kB message and an unknown message type disconnect as well
    const c = await join('Carl');
    await until(() => names().length === 2);
    const leftC = new Promise<number>((resolve) => c.onLeave(resolve));
    c.sendBytes('i', new Uint8Array(10_000));
    expect(await leftC).toBeGreaterThan(1000);
    await until(() => names().length === 1);
    const d = await join('Dora');
    await until(() => names().length === 2);
    const leftD = new Promise<number>((resolve) => d.onLeave(resolve));
    d.send('hax', { x: 1 });
    expect(await leftD).toBe(4400);

    // a burst of far more messages per second than any client sends is dropped by Colyseus
    await until(() => names().length === 1);
    const f = await join('Fritz');
    await until(() => names().length === 2);
    const leftF = new Promise<number>((resolve) => f.onLeave(resolve));
    for (let n = 0; n < 400; n++) f.sendBytes('i', encodeInputs({ seq: n + 1, tick: 0, inputs: [NEUTRAL_INPUT(0)] }));
    expect(await leftF).toBeGreaterThan(1000);

    // Bert still receives state updates
    await until(() => names().length === 1);
    const e = await join('Emil');
    await until(() => names().join() === 'Bert,Emil');
    expect(b.connection.isOpen).toBe(true);
    await leaveAll();
  }, 20_000);
});
