import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type Room } from '@colyseus/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeNpcBatch, decodeSnapshot, encodeInputs, headingOf, KNOCKDOWN_S, NEUTRAL_INPUT, PROTOCOL_VERSION, weatherPreset, worldHash,
  type PlayerInput, type Snapshot,
} from '@nn/shared';
import { loadConfig } from './config';
import { INPUT_BURST, QUEUE_MAX } from './inputs';
import { startServer, type RunningServer } from './server';

const clientDir = mkdtempSync(join(tmpdir(), 'nn-dist-'));
writeFileSync(join(clientDir, 'index.html'), '<h1>nippes</h1>');
const base = { port: 0, maxPlayers: 2, logLevel: 'error' as const, joinPerMin: 1000, reconnectS: 3, clientDir, weather: 'off' as const };
const cfg = loadConfig({}, base);
const haveAssets = ['manifest.json', 'collision.bin', 'terrain.bin'].every((f) => existsSync(`${cfg.worldDir}/${f}`));
const haveNpc = haveAssets && existsSync(`${cfg.worldDir}/npc.json`);

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
    // handlers a test does not care about (a test's own onMessage replaces these)
    r.onMessage('s', () => undefined);
    r.onMessage('welcome', () => undefined);
    r.onMessage('n', () => undefined);
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

  it('a player beyond maxPlayers is rejected (maxPlayers 2: the third)', async () => {
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
    const t0 = Date.now();
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
    // MAX_INPUTS_PER_S over the time the flood really took (longer than 1.1 s on a loaded machine), plus the burst
    expect(q.accepted).toBeLessThanOrEqual(Math.ceil((90 * (Date.now() - t0)) / 1000) + INPUT_BURST);
    // the backlog stays bounded (one input per tick is taken from it, so the flood does not speed the player up)
    expect(q.size).toBeLessThanOrEqual(QUEUE_MAX);
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

  /** Sends one input per 16 ms like a client; `input` can be changed while it runs. */
  class Pilot {
    input: PlayerInput = NEUTRAL_INPUT(0);
    private seq = 1;
    private readonly timer: NodeJS.Timeout;
    constructor(private room: Room) {
      this.timer = setInterval(() => this.send(), 16);
    }
    send(): void {
      if (this.room.connection.isOpen) this.room.sendBytes('i', encodeInputs({ seq: this.seq++, tick: 0, inputs: [this.input] }));
    }
    /** Sends `use` for exactly one input. */
    press(): void {
      const keep = this.input;
      this.input = { ...keep, use: true };
      this.send();
      this.input = keep;
    }
    stop(): void {
      clearInterval(this.timer);
    }
  }
  /** Latest snapshot and all events a client received. */
  const watch = (r: Room) => {
    const w = { last: null as Snapshot | null, events: [] as Snapshot['events'], count: 0, ownModes: [] as number[], modeAt: [] as { tick: number; mode: number }[] };
    r.onMessage('s', (bytes: Uint8Array) => {
      const snap = decodeSnapshot(new Uint8Array(bytes));
      if (!snap) return;
      w.last = snap;
      w.count++;
      w.events.push(...snap.events);
      if (w.ownModes[w.ownModes.length - 1] !== snap.own.mode) {
        w.ownModes.push(snap.own.mode);
        w.modeAt.push({ tick: snap.serverTick, mode: snap.own.mode });
      }
    });
    return w;
  };
  /** Kills the socket like a dead network (no close handshake), from the server's end of the pipe. */
  const hardClose = (r: Room) =>
    (srv.room.clients.find((c) => c.sessionId === r.sessionId)!.ref as unknown as { terminate(): void }).terminate();
  const slotOf = (r: Room) => srv.room.slotOf(r.sessionId)!;
  const teleport = (r: Room, x: number, z: number) => r.send('devTeleport', { x, z });
  /** Position beside car 0 (right side, 2 m) so that `use` enters it. */
  const besideCar = (side: number) => {
    const pose = srv.room.sim.cars.vehicle(0)?.pose() ?? srv.room.sim.cars.poses[0]!;
    const h = headingOf(pose);
    return { pose, h, x: pose.x + Math.cos(h) * side, z: pose.z - Math.sin(h) * side };
  };

  it('two clients see each other', async () => {
    const a = await join('Anna'), b = await join('Bert');
    const wa = watch(a), wb = watch(b);
    await until(() => !!wa.last && !!wb.last);
    expect(wa.last!.walkers.map((w) => w.slot)).toEqual([slotOf(b)]);
    expect(wb.last!.walkers.map((w) => w.slot)).toEqual([slotOf(a)]);
    // 20 Hz
    const c0 = wa.count;
    await sleep(1000);
    expect(wa.count - c0).toBeGreaterThanOrEqual(15);
    expect(wa.count - c0).toBeLessThanOrEqual(25);
    await leaveAll();
  });

  it('enter is exclusive', async () => {
    const a = await join('Anna'), b = await join('Bert');
    const { x, z } = besideCar(2);
    teleport(a, x, z);
    teleport(b, x + 0.3, z);
    await sleep(300);
    const pa = new Pilot(a), pb = new Pilot(b);
    pa.press();
    pb.press();
    await sleep(500);
    pa.stop();
    pb.stop();
    const modes = [slotOf(a), slotOf(b)].map((s) => srv.room.sim.player(s).mode);
    expect(modes.filter((m) => m === 'drive')).toHaveLength(1);
    expect(srv.room.sim.cars.driver[0]).not.toBeNull();
    await leaveAll();
  });

  /**
   * A bike with no car within 6 m and no other bike within 4 m (E there can only mean this bike), nearest the spawn,
   * and the points 1 m left/right of it.
   */
  const lonelyBike = () => {
    const sim = srv.room.sim, sp = sim.bikes.poses[0]!;
    let best = -1, bestD = Infinity;
    sim.bikes.poses.forEach((b, i) => {
      if (sim.bikes.rider[i] !== null || sim.cars.poses.some((c) => Math.hypot(c.x - b.x, c.z - b.z) < 6)) return;
      if (sim.bikes.poses.some((o, j) => j !== i && Math.hypot(o.x - b.x, o.z - b.z) < 4)) return;
      const d = Math.hypot(b.x - sp.x, b.z - sp.z);
      if (d < bestD) [best, bestD] = [i, d];
    });
    const b = sim.bikes.poses[best]!;
    const lx = Math.cos(b.heading), lz = -Math.sin(b.heading);
    return { id: best, left: { x: b.x + lx, z: b.z + lz }, right: { x: b.x - lx, z: b.z - lz } };
  };

  it('mount is exclusive and the other client sees the rider', async () => {
    const a = await join('Anna'), b = await join('Bert');
    const wa = watch(a), wb = watch(b);
    const bike = lonelyBike();
    teleport(a, bike.left.x, bike.left.z);
    teleport(b, bike.right.x, bike.right.z);
    await sleep(300);
    const pa = new Pilot(a), pb = new Pilot(b);
    pa.press();
    pb.press();
    await sleep(500);
    const slots = [slotOf(a), slotOf(b)];
    const modes = slots.map((s) => srv.room.sim.player(s).mode);
    expect(modes.filter((m) => m === 'ride')).toHaveLength(1);
    const rider = slots[modes.indexOf('ride')]!;
    expect(srv.room.sim.bikes.rider[bike.id]).toBe(rider);
    const [riderRoom, otherWatch, riderWatch] = rider === slots[0] ? [a, wb, wa] : [b, wa, wb];
    // the rider's own snapshot says ride on that bike; the other one sees a rider entry and the slow state
    await until(() => riderWatch.last?.own.mode === 3 && otherWatch.last!.riders.length === 1);
    expect(riderWatch.last!.own.bikeId).toBe(bike.id);
    expect(otherWatch.last!.riders[0]).toMatchObject({ slot: rider, bikeId: bike.id });
    expect(otherWatch.last!.walkers.map((w) => w.slot)).not.toContain(rider);
    const other = rider === slots[0] ? b : a;
    const st = other.state as { players: Map<string, { mode: number; bikeId: number }>; bikes: Map<string, { rider: number }> };
    await until(() => st.bikes.get(String(bike.id))?.rider === rider);
    expect(st.players.get(String(rider))).toMatchObject({ mode: 3, bikeId: bike.id });
    // pedalling away: the other client's rider entry follows
    const p0 = otherWatch.last!.riders[0]!;
    (rider === slots[0] ? pa : pb).input = { ...NEUTRAL_INPUT(0), forward: 1 };
    await until(() => Math.hypot(otherWatch.last!.riders[0]!.x - p0.x, otherWatch.last!.riders[0]!.z - p0.z) > 2, 5000);
    expect(riderRoom.connection.isOpen).toBe(true);
    pa.stop();
    pb.stop();
    await leaveAll();
  }, 20_000);

  it('the character variant from the join options is in the player state (validated)', async () => {
    const a = await join('Anna', { variant: 1 }), b = await join('Bert', { variant: 99 });
    const st = b.state as { players: Map<string, { variant: number }> };
    await until(() => st.players?.size === 2);
    expect(st.players.get(String(slotOf(a)))!.variant).toBe(1);
    expect(st.players.get(String(slotOf(b)))!.variant).toBe(0);
    b.send('variant', 1);
    await until(() => st.players.get(String(slotOf(b)))!.variant === 1);
    a.send('variant', -3);
    await until(() => st.players.get(String(slotOf(a)))!.variant === 0);
    await leaveAll();
  });

  it('car hits walker → down, up after KNOCKDOWN_S', async () => {
    const a = await join('Anna'), b = await join('Bert');
    const wb = watch(b);
    const { x, z, h } = besideCar(2);
    teleport(a, x, z);
    await sleep(300);
    const pa = new Pilot(a);
    pa.press();
    await until(() => srv.room.sim.player(slotOf(a)).mode === 'drive');
    // B stands 12 m ahead of the car
    const car = srv.room.sim.cars.vehicle(0)!.pose();
    teleport(b, car.x + Math.sin(h) * 12, car.z + Math.cos(h) * 12);
    pa.input = { ...NEUTRAL_INPUT(0), forward: 1 };
    await until(() => wb.events.some((e) => e.t === 'knock'), 8000);
    pa.input = { ...NEUTRAL_INPUT(0), brake: true }; // stop before running him over again
    expect(wb.events).toContainEqual({ t: 'knock', slot: slotOf(b) });
    await until(() => wb.modeAt.some((m) => m.mode === 2) && wb.last!.own.mode !== 2, (KNOCKDOWN_S + 3) * 1000);
    const down = wb.modeAt.findIndex((m) => m.mode === 2);
    const downS = (wb.modeAt[down + 1]!.tick - wb.modeAt[down]!.tick) / 60;
    expect(Math.abs(downS - KNOCKDOWN_S)).toBeLessThanOrEqual(0.1 + 1 / 20); // ± 0.1 s, measured at 20 Hz resolution
    pa.stop();
    await leaveAll();
  }, 30_000);

  it('reconnect within the window keeps player and car', async () => {
    const a = await join('Anna');
    const { x, z } = besideCar(2);
    teleport(a, x, z);
    await sleep(300);
    const pa = new Pilot(a);
    pa.press();
    await until(() => srv.room.sim.player(slotOf(a)).mode === 'drive');
    pa.stop();
    const slot = slotOf(a), token = a.reconnectionToken;
    open.splice(open.indexOf(a), 1);
    hardClose(a);
    await sleep(1200);
    expect(srv.room.sim.player(slot).mode).toBe('drive');
    expect(srv.room.sim.cars.driver[0]).toBe(slot);
    const a2 = await client().reconnect(token);
    open.push(a2);
    const w = watch(a2);
    await until(() => !!w.last);
    expect(slotOf(a2)).toBe(slot);
    expect(w.last!.own.mode).toBe(1);
    expect(w.last!.own.carId).toBe(0);
    expect(srv.room.sim.cars.driver[0]).toBe(slot);
    await leaveAll();
  }, 20_000);

  it('after the window the player is gone and the car is free', async () => {
    const a = await join('Anna');
    const { x, z } = besideCar(2);
    teleport(a, x, z);
    await sleep(300);
    const pa = new Pilot(a);
    pa.press();
    await until(() => srv.room.sim.player(slotOf(a)).mode === 'drive');
    pa.stop();
    const slot = slotOf(a);
    open.splice(open.indexOf(a), 1);
    hardClose(a);
    await sleep(1500);
    expect(srv.room.sim.hasPlayer(slot)).toBe(true);
    await until(() => !srv.room.sim.hasPlayer(slot), 5000);
    expect(srv.room.sim.cars.driver[0]).toBeNull();
    await until(() => srv.room.clients.length === 0);
  }, 20_000);

  it('serves the built client next to the matchmaker', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(await r.text()).toBe('<h1>nippes</h1>');
    expect((await fetch(`http://127.0.0.1:${srv.port}/missing.js`)).status).toBe(404);
  });

  it.skipIf(!haveNpc)('clients receive npc batches near the spawn', async () => {
    const a = await join('Anna');
    const plans = new Map<number, number>();
    a.onMessage('n', (bytes: Uint8Array) => {
      const b = decodeNpcBatch(bytes);
      for (const m of b?.msgs ?? []) if (m.t === 'plan') plans.set(m.plan.id, m.plan.startTick);
    });
    await until(() => plans.size >= 20, 15_000);
    const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    const h = (await r.json()) as { npcs: number; npcDensity: number };
    expect(h.npcs).toBeGreaterThanOrEqual(20);
    expect(h.npcDensity).toBeGreaterThan(0);
    await leaveAll();
  }, 30_000);

  it('/healthz reports players, tick p95, dropped steps and memory', async () => {
    await join('Anna');
    const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    expect(r.status).toBe(200);
    const h = (await r.json()) as { players: number; tickP95Ms: number; dropped: number; ticks: number; droppedTotal: number; rssMb: number };
    expect(h.players).toBe(1);
    expect(h.ticks).toBeGreaterThan(0);
    expect(Number.isInteger(h.droppedTotal)).toBe(true);
    expect(h.rssMb).toBeGreaterThan(10);
    expect(h.tickP95Ms).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h.dropped)).toBe(true);
    await leaveAll();
  });

  // Uses the shared server: a fixed weather is just room.setWeather() at startup (server.ts), and a second
  // startServer() reloads the whole world, which alone can take >20 s on a CI runner.
  it('syncs the weather through the room state', async () => {
    srv.room.setWeather(weatherPreset('snow')!);
    const c = await join('Anna');
    const w = () => c.state as unknown as { weather: { known: boolean; kind: string } };
    await until(() => w().weather?.known === true && w().weather.kind === 'snow');
    srv.room.setWeather(weatherPreset('rain')!);
    await until(() => w().weather.kind === 'rain');
    await leaveAll();
  });
});
