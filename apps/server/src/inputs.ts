import { MAX_INPUTS_PER_S, NEUTRAL_INPUT, type InputPacket, type PlayerInput } from '@nn/shared';

/**
 * Most inputs held per player (0.5 s at 60 Hz); a longer backlog drops the oldest. A client that renders slowly sends
 * its fixed steps bunched (a frame of 8 steps at 7.5 fps arrives at once): all of them must fit.
 */
export const QUEUE_MAX = 30;
/** Token bucket size: inputs a client may send at once on top of the steady MAX_INPUTS_PER_S (as many as the queue holds). */
export const INPUT_BURST = QUEUE_MAX;
/** Dry ticks (empty queue) for which the last input's continuous fields are repeated: 100 ms, then neutral. */
export const REPEAT_MAX = 6;
/** Ticks over which the queue's low-water mark is taken (1 s). */
export const TRIM_WINDOW = 60;
/** A queue that never held fewer than TRIM_ABOVE inputs for a whole window is a standing backlog: trimmed to TRIM_TO. */
export const TRIM_ABOVE = 4;
export const TRIM_TO = 2;

type Entry = { seq: number; input: PlayerInput; arrival: number };

/** Increases with every queued input of any player: the order in which inputs reached the server. */
let arrivals = 0;

/**
 * One player's pending inputs, one consumed per tick. Duplicate or old seqs (a client re-sending its last inputs) and
 * everything beyond MAX_INPUTS_PER_S (token bucket) are dropped. A tick without a queued input repeats the last
 * input's continuous fields (forward, right, run, brake, horn, yaw) for up to REPEAT_MAX ticks (a late packet is not a
 * stutter), pulses (use, jump, bell) never; after that it is neutral with the last yaw, so a dropped driver's car rolls
 * out instead of driving on.
 *
 * Each dry tick leaves one more input waiting from then on (the server ran a step the client did not send). A late
 * burst after a stall would so keep delaying all later input; when the queue has not run below TRIM_ABOVE for a whole
 * TRIM_WINDOW, the oldest inputs are dropped down to TRIM_TO, one per tick. Dropped inputs (also beyond QUEUE_MAX) hand
 * their pulses to the next one.
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
  /** Fewest inputs queued at a tick in the current window, ticks into it, and inputs still to trim. */
  private low = Infinity;
  private windowTicks = 0;
  private trim = 0;

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
      if (this.q.length > QUEUE_MAX) this.dropOldest();
    });
  }

  /** This tick's input: the oldest queued one, else the last one's continuous fields for 6 ticks, then neutral. */
  next(): PlayerInput {
    this.trimBacklog();
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

  /** Low-water mark of the window; a standing backlog loses its oldest input, one per tick. */
  private trimBacklog(): void {
    this.low = Math.min(this.low, this.q.length);
    if (++this.windowTicks >= TRIM_WINDOW) {
      if (this.low >= TRIM_ABOVE) this.trim = this.low - TRIM_TO;
      this.low = Infinity;
      this.windowTicks = 0;
    }
    if (this.trim > 0 && this.q.length > TRIM_TO) {
      this.dropOldest();
      this.trim--;
    }
    // the backlog is gone (trimmed, or drained because the client stopped sending): what was left to trim must not
    // eat into a later bunched frame
    if (this.q.length <= TRIM_TO) this.trim = 0;
  }

  /** Drops the oldest queued input; its pulses (use, jump, bell) go to the next one. */
  private dropOldest(): void {
    const gone = this.q.shift()!.input;
    const head = this.q[0];
    if (!head || !(gone.use || gone.jump || gone.bell)) return;
    head.input = { ...head.input, use: head.input.use || gone.use, jump: head.input.jump || gone.jump, bell: head.input.bell === true || gone.bell === true };
  }

  private refill(nowMs: number): void {
    if (this.refilledAt !== null && nowMs > this.refilledAt) {
      this.tokens = Math.min(INPUT_BURST, this.tokens + ((nowMs - this.refilledAt) * MAX_INPUTS_PER_S) / 1000);
    }
    if (this.refilledAt === null || nowMs > this.refilledAt) this.refilledAt = nowMs;
  }
}
