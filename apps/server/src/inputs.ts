import { MAX_INPUTS_PER_S, NEUTRAL_INPUT, type InputPacket, type PlayerInput } from '@nn/shared';

/** Most inputs held per player: about 100 ms of jitter at 60 Hz; older ones fall out. */
export const QUEUE_MAX = 6;
/** Token bucket size: inputs a client may send at once on top of the steady MAX_INPUTS_PER_S. */
export const INPUT_BURST = 6;
/** Dry ticks (empty queue) for which the last input's continuous fields are repeated: 100 ms, then neutral. */
export const REPEAT_MAX = 6;

type Entry = { seq: number; input: PlayerInput; arrival: number };

/** Increases with every queued input of any player: the order in which inputs reached the server. */
let arrivals = 0;

/**
 * One player's pending inputs, one consumed per tick. Duplicate or old seqs (a client re-sending its last inputs) and
 * everything beyond MAX_INPUTS_PER_S (token bucket) are dropped. A tick without a queued input repeats the last
 * input's continuous fields (forward, right, run, brake, horn, yaw) for up to REPEAT_MAX ticks (a late packet is not a
 * stutter), pulses (use, jump, bell) never; after that it is neutral with the last yaw, so a dropped driver's car rolls
 * out instead of driving on.
 */
export class InputQueue {
  /** Seq of the newest input applied by next() (the ack the client reconciles against). */
  ackSeq = 0;
  /** Inputs accepted into the queue so far (diagnostics). */
  accepted = 0;
  private lastQueued = -1;
  private lastYaw: number;
  private last: PlayerInput | null = null;
  private dry = 0;
  private readonly q: Entry[] = [];
  private tokens = INPUT_BURST;
  private refilledAt: number | null = null;

  constructor(yaw: number) {
    this.lastYaw = yaw;
  }

  get size(): number {
    return this.q.length;
  }

  /** Arrival order of the next input, or Infinity while the queue is empty. */
  get headArrival(): number {
    return this.q[0]?.arrival ?? Infinity;
  }

  push(p: InputPacket, nowMs: number): void {
    this.refill(nowMs);
    p.inputs.forEach((input, k) => {
      const seq = p.seq + k;
      if (seq <= this.lastQueued) return;
      if (this.tokens < 1) return; // not marked as queued: a later re-send of this seq may still get in
      this.tokens--;
      this.lastQueued = seq;
      this.q.push({ seq, input, arrival: arrivals++ });
      this.accepted++;
      if (this.q.length > QUEUE_MAX) this.q.shift();
    });
  }

  /** This tick's input: the oldest queued one, else the last one's continuous fields for 6 ticks, then neutral. */
  next(): PlayerInput {
    const e = this.q.shift();
    if (!e) {
      if (!this.last || this.dry >= REPEAT_MAX) return NEUTRAL_INPUT(this.lastYaw);
      this.dry++;
      const { forward, right, run, brake, horn, yaw } = this.last;
      return { ...NEUTRAL_INPUT(yaw), forward, right, run, brake, ...(horn ? { horn } : {}) };
    }
    this.ackSeq = e.seq;
    this.lastYaw = e.input.yaw;
    this.last = e.input;
    this.dry = 0;
    return e.input;
  }

  private refill(nowMs: number): void {
    if (this.refilledAt !== null && nowMs > this.refilledAt) {
      this.tokens = Math.min(INPUT_BURST, this.tokens + ((nowMs - this.refilledAt) * MAX_INPUTS_PER_S) / 1000);
    }
    if (this.refilledAt === null || nowMs > this.refilledAt) this.refilledAt = nowMs;
  }
}
