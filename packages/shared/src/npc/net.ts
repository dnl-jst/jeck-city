import { NPC_ACTIONS, NPC_KINDS, type Plan, type SpeedRamp } from './types';

/**
 * Message 'n' (server → client): NPC plans, departures and what they say, batched once per snapshot round.
 *
 * Layout (big-endian): version u8, tick u32, count u16, then per message a type u8 and:
 * - plan: id u32, kind | action << 2 u8, seq u16, startTick u32, look (variant u8, tint u24, scale i8 ‰ around 1,
 *   vehicleType i8, vehicleColor u24), points u8, first point (x i24, y i24, z i24 in cm), each further point as
 *   deltas (i16 cm), ramps u8, start speed u16 cm/s, per ramp its end distance u24 cm and end speed u16 cm/s.
 *   Ramps are contiguous from distance 0 (as buildPlan makes them).
 * - gone / honk: id u32 · say: id u32, line u8.
 */
export type NpcMsg =
  | { t: 'plan'; plan: Plan }
  | { t: 'gone'; id: number }
  | { t: 'say'; id: number; line: number }
  | { t: 'honk'; id: number };
export type NpcBatch = { tick: number; msgs: NpcMsg[] };

const VERSION = 1;
const TYPE = { plan: 0, gone: 1, say: 2, honk: 3 } as const;
/** Largest per-point delta (m) an i16 in cm holds; longer segments are split. */
const MAX_DELTA = 327;

class W {
  private buf = new Uint8Array(256);
  private dv = new DataView(this.buf.buffer);
  o = 0;
  private room(n: number): void {
    if (this.o + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.o + n));
    b.set(this.buf);
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  private int(v: number, lo: number, hi: number): number {
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0;
  }
  u8(v: number): void { this.room(1); this.dv.setUint8(this.o++, this.int(v, 0, 255)); }
  i8(v: number): void { this.room(1); this.dv.setInt8(this.o++, this.int(v, -128, 127)); }
  u16(v: number): void { this.room(2); this.dv.setUint16(this.o, this.int(v, 0, 65535)); this.o += 2; }
  i16(v: number): void { this.room(2); this.dv.setInt16(this.o, this.int(v, -32768, 32767)); this.o += 2; }
  u32(v: number): void { this.room(4); this.dv.setUint32(this.o, this.int(v, 0, 4294967295)); this.o += 4; }
  u24(v: number): void {
    const n = this.int(v, 0, 0xffffff);
    this.room(3);
    this.dv.setUint8(this.o, n >> 16);
    this.dv.setUint16(this.o + 1, n & 0xffff);
    this.o += 3;
  }
  i24(v: number): void { this.u24(this.int(v, -0x800000, 0x7fffff) & 0xffffff); }
  bytes(): Uint8Array { return this.buf.slice(0, this.o); }
}

class Short extends Error {}

class R {
  private readonly dv: DataView;
  o = 0;
  constructor(private readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): void {
    if (this.o + n > this.b.byteLength) throw new Short();
  }
  u8(): number { this.need(1); return this.dv.getUint8(this.o++); }
  i8(): number { this.need(1); return this.dv.getInt8(this.o++); }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.o); this.o += 2; return v; }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.o); this.o += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.o); this.o += 4; return v; }
  u24(): number { this.need(3); const v = (this.dv.getUint8(this.o) << 16) | this.dv.getUint16(this.o + 1); this.o += 3; return v; }
  i24(): number { const n = this.u24(); return n & 0x800000 ? n - 0x1000000 : n; }
  get done(): boolean { return this.o === this.b.byteLength; }
}

const cm = (v: number): number => Math.round(v * 100);

function writePlan(w: W, p: Plan): void {
  w.u32(p.id);
  w.u8(NPC_KINDS.indexOf(p.kind) | (NPC_ACTIONS.indexOf(p.action) << 2));
  w.u16(p.seq & 0xffff);
  w.u32(p.startTick);
  w.u8(p.look.variant);
  w.u24(p.look.tint);
  w.i8((p.look.scale - 1) * 1000);
  w.i8(p.look.vehicleType);
  w.u24(p.look.vehicleColor);
  // points in cm; each delta is taken from the rounded previous point, so rounding errors do not add up
  const pts: [number, number, number][] = [];
  for (const q of p.path) {
    const c: [number, number, number] = [cm(q.x), cm(q.y), cm(q.z)];
    const last = pts[pts.length - 1];
    if (last) {
      const span = Math.max(Math.abs(c[0] - last[0]), Math.abs(c[1] - last[1]), Math.abs(c[2] - last[2]));
      const parts = Math.ceil(span / (MAX_DELTA * 100));
      for (let k = 1; k < parts; k++) pts.push([0, 1, 2].map((j) => Math.round(last[j]! + ((c[j]! - last[j]!) * k) / parts)) as [number, number, number]);
    }
    pts.push(c);
  }
  w.u8(Math.min(255, pts.length));
  pts.slice(0, 255).forEach((c, i) => {
    if (i === 0) {
      w.i24(c[0]); w.i24(c[1]); w.i24(c[2]);
    } else {
      const l = pts[i - 1]!;
      w.i16(c[0] - l[0]); w.i16(c[1] - l[1]); w.i16(c[2] - l[2]);
    }
  });
  w.u8(Math.min(255, p.ramps.length));
  w.u16(cm(p.ramps[0]?.v0 ?? 0));
  for (const r of p.ramps.slice(0, 255)) {
    w.u24(cm(r.s1));
    w.u16(cm(r.v1));
  }
}

function readPlan(r: R): Plan | null {
  const id = r.u32();
  const ka = r.u8();
  const kind = NPC_KINDS[ka & 3], action = NPC_ACTIONS[ka >> 2];
  if (!kind || !action) return null;
  const seq = r.u16(), startTick = r.u32();
  const look = { variant: r.u8(), tint: r.u24(), scale: 1 + r.i8() / 1000, vehicleType: r.i8(), vehicleColor: r.u24() };
  const n = r.u8();
  if (n === 0) return null;
  const path = [];
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      x = r.i24(); y = r.i24(); z = r.i24();
    } else {
      x += r.i16(); y += r.i16(); z += r.i16();
    }
    path.push({ x: x / 100, y: y / 100, z: z / 100 });
  }
  const nr = r.u8();
  let v = r.u16() / 100, s = 0;
  const ramps: SpeedRamp[] = [];
  for (let i = 0; i < nr; i++) {
    const s1 = r.u24() / 100, v1 = r.u16() / 100;
    ramps.push({ s0: s, s1, v0: v, v1 });
    s = s1;
    v = v1;
  }
  return { id, kind, look, startTick, path, ramps, action, seq };
}

export function encodeNpcBatch(b: NpcBatch): Uint8Array {
  const w = new W();
  w.u8(VERSION);
  w.u32(b.tick);
  w.u16(Math.min(65535, b.msgs.length));
  for (const m of b.msgs.slice(0, 65535)) {
    w.u8(TYPE[m.t]);
    if (m.t === 'plan') writePlan(w, m.plan);
    else {
      w.u32(m.id);
      if (m.t === 'say') w.u8(m.line);
    }
  }
  return w.bytes();
}

/** The batch, or null for anything malformed (truncated, unknown version or type, trailing bytes). */
export function decodeNpcBatch(b: Uint8Array): NpcBatch | null {
  try {
    const r = new R(b);
    if (r.u8() !== VERSION) return null;
    const tick = r.u32();
    const count = r.u16();
    const msgs: NpcMsg[] = [];
    for (let i = 0; i < count; i++) {
      const t = r.u8();
      if (t === TYPE.plan) {
        const plan = readPlan(r);
        if (!plan) return null;
        msgs.push({ t: 'plan', plan });
      } else if (t === TYPE.gone) msgs.push({ t: 'gone', id: r.u32() });
      else if (t === TYPE.say) msgs.push({ t: 'say', id: r.u32(), line: r.u8() });
      else if (t === TYPE.honk) msgs.push({ t: 'honk', id: r.u32() });
      else return null;
    }
    return r.done ? { tick, msgs } : null;
  } catch (e) {
    if (e instanceof Short) return null;
    throw e;
  }
}
