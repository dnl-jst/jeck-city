import {
  NPC_BLEND_S, NPC_FADE_IN_S, NPC_PERSON_BODY_RADIUS, planAt, type NpcAction, type NpcBatch, type NpcBody, type NpcKind, type NpcLook, type NpcPose,
  type NpcSource, type Plan,
} from '@nn/shared';

/** What the renderer needs of one NPC this frame. alpha: fade in/out 0..1; say: the line shown and its age (s). */
export type NpcDraw = {
  id: number; kind: NpcKind; look: NpcLook; pose: NpcPose; action: NpcAction; alpha: number;
  say: { line: number; age: number } | null; honk: boolean;
  /** Ms since the current plan arrived (renderers start a fall or a get-up from it). */
  planAgeMs: number;
};

/** How long a line is shown (s), how long a horn sounds (ms), how long a departing NPC fades out (ms). */
const SAY_S = 3, HONK_MS = 500, GONE_MS = 300;

type Entry = {
  plan: Plan;
  /** The pose shown when the current plan arrived (blended from over NPC_BLEND_S), or null. */
  from: { x: number; y: number; z: number; heading: number } | null;
  planMs: number; bornMs: number; goneMs: number | null;
  say: { line: number; atMs: number } | null; honkMs: number;
};

const lerpAngle = (a: number, b: number, k: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

/**
 * The client's NPCs, from the server's 'n' batches (or the offline director's messages): each one's newest plan,
 * evaluated at the tick asked for. A replaced plan is blended into over NPC_BLEND_S from where the NPC was shown, new
 * NPCs fade in over NPC_FADE_IN_S, departing ones fade out. Also the source of the NPC bodies in the prediction world.
 */
export class ClientNpcFeed implements NpcSource {
  private readonly npcs = new Map<number, Entry>();

  get count(): number {
    return this.npcs.size;
  }

  /** A batch received at nowMs; tick: the tick the NPCs are shown at now (for the blend's starting pose). */
  push(batch: NpcBatch, nowMs: number, tick: number): void {
    for (const m of batch.msgs) {
      if (m.t === 'plan') {
        const e = this.npcs.get(m.plan.id);
        if (!e || e.goneMs !== null) {
          this.npcs.set(m.plan.id, { plan: m.plan, from: null, planMs: nowMs, bornMs: nowMs, goneMs: null, say: null, honkMs: -Infinity });
          continue;
        }
        if (seqOlder(m.plan.seq, e.plan.seq)) continue;
        const shown = this.pose(e, tick, nowMs);
        e.from = { x: shown.x, y: shown.y, z: shown.z, heading: shown.heading };
        e.plan = m.plan;
        e.planMs = nowMs;
      } else {
        const e = this.npcs.get(m.id);
        if (!e) continue;
        if (m.t === 'gone') e.goneMs ??= nowMs;
        else if (m.t === 'say') e.say = { line: m.line, atMs: nowMs };
        else e.honkMs = nowMs;
      }
    }
  }

  private pose(e: Entry, tick: number, nowMs: number): NpcPose {
    const p = planAt(e.plan, tick);
    if (!e.from) return p;
    const k = Math.min(1, (nowMs - e.planMs) / (NPC_BLEND_S * 1000));
    if (k >= 1) {
      e.from = null;
      return p;
    }
    return {
      ...p, x: e.from.x + (p.x - e.from.x) * k, y: e.from.y + (p.y - e.from.y) * k, z: e.from.z + (p.z - e.from.z) * k,
      heading: lerpAngle(e.from.heading, p.heading, k),
    };
  }

  /** Every NPC as shown at `tick` (fractional ticks are fine) and nowMs. */
  draws(tick: number, nowMs: number): NpcDraw[] {
    const out: NpcDraw[] = [];
    for (const [id, e] of this.npcs) {
      let alpha = Math.max(0, Math.min(1, (nowMs - e.bornMs) / (NPC_FADE_IN_S * 1000)));
      if (e.goneMs !== null) {
        const k = (nowMs - e.goneMs) / GONE_MS;
        if (k >= 1) {
          this.npcs.delete(id);
          continue;
        }
        alpha = Math.min(alpha, 1 - k);
      }
      const sayAge = e.say ? (nowMs - e.say.atMs) / 1000 : Infinity;
      out.push({
        id, kind: e.plan.kind, look: e.plan.look, pose: this.pose(e, tick, nowMs), action: e.plan.action, alpha,
        say: e.say && sayAge < SAY_S ? { line: e.say.line, age: sayAge } : null, honk: nowMs - e.honkMs < HONK_MS,
        planAgeMs: nowMs - e.planMs,
      });
    }
    return out;
  }

  /** NPCs within r of the points at `tick`, exactly where their plans put them (as on the server). */
  bodiesNear(tick: number, points: readonly { x: number; z: number }[], r: number): NpcBody[] {
    const out: NpcBody[] = [];
    for (const [id, e] of this.npcs) {
      if (e.goneMs !== null) continue;
      const p = planAt(e.plan, tick);
      const rr = e.plan.kind === 'driver' ? r : Math.min(r, NPC_PERSON_BODY_RADIUS);
      if (!points.some((q) => Math.hypot(p.x - q.x, p.z - q.z) <= rr)) continue;
      out.push({ id, kind: e.plan.kind, x: p.x, y: p.y, z: p.z, heading: p.heading, pitch: p.pitch, vehicleType: e.plan.look.vehicleType, lying: e.plan.action === 'down' });
    }
    return out;
  }

  clear(): void {
    this.npcs.clear();
  }
}

/** Whether 16-bit plan sequence a is older than b (wrapping). */
function seqOlder(a: number, b: number): boolean {
  const d = (b - a) & 0xffff;
  return d !== 0 && d < 0x8000;
}
