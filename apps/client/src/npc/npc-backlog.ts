import type { NpcBatch, Plan } from '@nn/shared';

/**
 * NPC batches that arrive before the game listens (the room is joined while the world still loads): folded into the
 * newest plan per NPC (dropped on `gone`), so the first batch with every NPC of the area is never lost and the memory
 * stays bounded by the number of NPCs. Sayings and horns from that time are over and dropped.
 */
export class NpcBacklog {
  private readonly plans = new Map<number, Plan>();
  private tick = -1;

  add(b: NpcBatch): void {
    this.tick = b.tick;
    for (const m of b.msgs) {
      if (m.t === 'plan') this.plans.set(m.plan.id, m.plan);
      else if (m.t === 'gone') this.plans.delete(m.id);
    }
  }

  /** Everything collected as one batch (null if nothing came), and empty again. */
  drain(): NpcBatch | null {
    if (this.tick < 0) return null;
    const out: NpcBatch = { tick: this.tick, msgs: [...this.plans.values()].map((plan) => ({ t: 'plan' as const, plan })) };
    this.plans.clear();
    this.tick = -1;
    return out;
  }
}
