import { INTEREST_RELEASE, NPC_INTEREST_RADIUS, type NpcBatch, type NpcDirector, type NpcMsg } from '@nn/shared';

/**
 * One client's view of the NPCs: which ones it knows (within NPC_INTEREST_RADIUS of it, kept until INTEREST_RELEASE).
 * collect() turns the director's messages since the last call into this client's batch: the current plan of every NPC
 * that came into its area, `gone` for those that left (or were dissolved), and plans, sayings and honks of the ones it
 * knows. Called once per snapshot round of the client.
 */
export class NpcFeed {
  private readonly known = new Set<number>();

  collect(dir: NpcDirector, tick: number, at: { x: number; z: number } | null, msgs: readonly NpcMsg[]): NpcBatch | null {
    const out: NpcMsg[] = [];
    const fresh = new Set<number>();
    if (at) {
      const keep = new Set(dir.idsNear(at.x, at.z, INTEREST_RELEASE));
      for (const id of [...this.known]) {
        if (keep.has(id) && dir.get(id)) continue;
        this.known.delete(id);
        out.push({ t: 'gone', id });
      }
      for (const id of dir.idsNear(at.x, at.z, NPC_INTEREST_RADIUS)) {
        if (this.known.has(id)) continue;
        const n = dir.get(id);
        if (!n) continue;
        this.known.add(id);
        fresh.add(id);
        out.push({ t: 'plan', plan: n.plan });
      }
    }
    for (const m of msgs) {
      if (m.t === 'plan') {
        if (this.known.has(m.plan.id) && !fresh.has(m.plan.id)) out.push(m);
      } else if (m.t === 'gone') {
        if (this.known.delete(m.id)) out.push(m);
      } else if (this.known.has(m.id)) out.push(m);
    }
    return out.length ? { tick, msgs: out } : null;
  }
}
