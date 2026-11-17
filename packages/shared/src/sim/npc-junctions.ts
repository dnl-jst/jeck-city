import type { NetGraph, NetLayer, NpcNet } from '../npc/netgraph';
import type { Approach, JunctionInfo, Light } from '../npc/signals';

/** Comfortable braking (m/s²): amber means stop if the stop line can be reached at this or less. */
export const STOP_DECEL = 3;

/** Whether a vehicle `dist` m before the stop line at `v` m/s may go on at `light`. */
export function lightAllows(light: Light, dist: number, v: number): boolean {
  if (light === 'green') return true;
  if (light === 'amber') return dist < (v * v) / (2 * STOP_DECEL);
  return false;
}

type Seg = [number, number, number, number];
function segsOf(g: NetGraph, e: number): Seg[] {
  const p = g.edges[e]!.pts;
  const out: Seg[] = [];
  for (let i = 1; i < p.length; i++) out.push([p[i - 1]![0], p[i - 1]![1], p[i]![0], p[i]![1]]);
  return out;
}
const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
function segsHit(a: Seg, b: Seg): boolean {
  const d1 = cross(b[0], b[1], b[2], b[3], a[0], a[1]), d2 = cross(b[0], b[1], b[2], b[3], a[2], a[3]);
  const d3 = cross(a[0], a[1], a[2], a[3], b[0], b[1]), d4 = cross(a[0], a[1], a[2], a[3], b[2], b[3]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** An approach of a junction as seen from its lane edge. */
export type ApproachRef = { j: number; ap: Approach; index: number };

/**
 * Lookups for the junctions of one layer (drive or cycle): which junction an approach lane or turn edge belongs to,
 * which turn edges conflict (cross each other or merge into the same lane; arcs from the same lane never conflict),
 * and the pedestrian signals of walk crossings.
 */
export class JunctionTables {
  readonly approachOf: Record<'drive' | 'cycle', Map<number, ApproachRef>> = { drive: new Map(), cycle: new Map() };
  readonly turnOf: Record<'drive' | 'cycle', Map<number, number>> = { drive: new Map(), cycle: new Map() };
  readonly pedOf = new Map<number, { j: number; group: 0 | 1 }>();
  private readonly conflicts = new Map<string, Set<string>>();

  constructor(private readonly net: NpcNet) {
    net.junctions.forEach((j, ji) => {
      j.approaches.forEach((ap, index) => this.approachOf.drive.set(ap.edge, { j: ji, ap, index }));
      j.cycleApproaches.forEach((ap, index) => this.approachOf.cycle.set(ap.edge, { j: ji, ap, index }));
      for (const e of j.turns) this.turnOf.drive.set(e, ji);
      for (const e of j.cycleTurns) this.turnOf.cycle.set(e, ji);
      for (const p of j.peds) this.pedOf.set(p.walkEdge, { j: ji, group: p.group });
    });
  }

  junction(i: number): JunctionInfo {
    return this.net.junctions[i]!;
  }

  /** Pairs "a,b" (a < b) of turn edges of junction j on `layer` that conflict. */
  conflictSet(j: number, layer: 'drive' | 'cycle' = 'drive'): Set<string> {
    const k = `${layer}:${j}`;
    let set = this.conflicts.get(k);
    if (set) return set;
    set = new Set();
    const g = this.net[layer as NetLayer];
    const turns = layer === 'drive' ? this.net.junctions[j]!.turns : this.net.junctions[j]!.cycleTurns;
    for (let x = 0; x < turns.length; x++) {
      for (let y = x + 1; y < turns.length; y++) {
        const a = turns[x]!, b = turns[y]!;
        const ea = g.edges[a]!, eb = g.edges[b]!;
        if (ea.a === eb.a) continue; // from the same lane: queue, not conflict
        const hit = ea.b === eb.b || segsOf(g, a).some((s) => segsOf(g, b).some((t) => segsHit(s, t)));
        if (hit) set.add(`${Math.min(a, b)},${Math.max(a, b)}`);
      }
    }
    this.conflicts.set(k, set);
    return set;
  }

  conflict(j: number, layer: 'drive' | 'cycle', a: number, b: number): boolean {
    return a !== b && this.conflictSet(j, layer).has(`${Math.min(a, b)},${Math.max(a, b)}`);
  }
}
