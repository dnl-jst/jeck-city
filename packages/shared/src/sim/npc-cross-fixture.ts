import type { NetEdge, NetGraph, NpcNet } from '../npc/netgraph';
import type { JunctionInfo } from '../npc/signals';

export type Arm = 'N' | 'E' | 'S' | 'W';
export const ARMS: Arm[] = ['E', 'S', 'W', 'N']; // by angle (x east, z south)
const DIR: Record<Arm, [number, number]> = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] };
/** Lanes start this far from the centre (the junction box), crossings lie here, sidewalks this far out. */
const BOX = 8, CROSS_AT = 10, WALK_OFF = 5, LANE_OFF = 1.5;

export type CrossNet = {
  net: NpcNet;
  /** Per arm: the lane towards the centre, the lane away from it, the walk crossing over the arm, the sidewalk right of the in-lane. */
  inLane: Record<Arm, number>; outLane: Record<Arm, number>; crossing: Record<Arm, number>; sidewalk: Record<Arm, number>;
  /** Turn edge from arm a to arm b. */
  turn: (a: Arm, b: Arm) => number;
  armLength: number;
};

/**
 * Test helper: a four-way junction at the origin with arms of `len` m. Drive (and cycle) graph: per arm an in-lane
 * (1.5 m right of the centre line, ending 8 m before the centre) and an out-lane, turn arcs between every in- and
 * other out-lane, and a turning loop at each arm's far end. Walk graph: sidewalks 5 m off the centre line, crossings
 * 10 m from the centre, corners. One junction info entry: groups N/S = 0, E/W = 1; ranks per arm; signal or not.
 */
export function crossNet(opts: { signal?: boolean; offsetTicks?: number; ranks?: Partial<Record<Arm, number>>; len?: number; walkWidth?: number } = {}): CrossNet {
  const len = opts.len ?? 100;
  const drive: NetGraph = { nodes: [], edges: [] };
  const node = (g: NetGraph, x: number, z: number): number => {
    const i = g.nodes.findIndex(([a, b]) => Math.abs(a - x) < 1e-6 && Math.abs(b - z) < 1e-6);
    if (i >= 0) return i;
    g.nodes.push([x, z]);
    return g.nodes.length - 1;
  };
  const edge = (g: NetGraph, pts: [number, number][], oneway: boolean, extra: Partial<NetEdge> = {}): number => {
    g.edges.push({ a: node(g, ...pts[0]!), b: node(g, ...pts[pts.length - 1]!), pts, width: 3, oneway, ...extra });
    return g.edges.length - 1;
  };
  const along = (a: Arm, t: number, off: number): [number, number] => {
    const [dx, dz] = DIR[a];
    const rx = -dz, rz = dx; // right of the arm's direction away from the centre
    return [dx * t + rx * off, dz * t + rz * off];
  };
  const inLane = {} as Record<Arm, number>, outLane = {} as Record<Arm, number>;
  for (const a of ARMS) {
    inLane[a] = edge(drive, [along(a, len, -LANE_OFF), along(a, BOX, -LANE_OFF)], true);
    outLane[a] = edge(drive, [along(a, BOX, LANE_OFF), along(a, len, LANE_OFF)], true);
    edge(drive, [along(a, len, LANE_OFF), along(a, len + 3, 0), along(a, len, -LANE_OFF)], true); // turning loop
  }
  const turns = new Map<string, number>();
  for (const a of ARMS) {
    for (const b of ARMS) {
      if (a === b) continue;
      const p = along(a, BOX, -LANE_OFF), q = along(b, BOX, LANE_OFF);
      // corner: where the arriving lane (travelling −dir a) meets the leaving one (travelling dir b); straight: midpoint
      const [ax, az] = DIR[a], [bx, bz] = DIR[b];
      const den = -ax * bz + az * bx;
      let m: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (Math.abs(den) > 1e-6) {
        const t = ((q[0] - p[0]) * bz - (q[1] - p[1]) * bx) / den;
        m = [p[0] - ax * t, p[1] - az * t];
      }
      const arc: [number, number][] = [];
      for (let k = 0; k <= 4; k++) {
        const u = k / 4, v = 1 - u;
        arc.push([v * v * p[0] + 2 * u * v * m[0] + u * u * q[0], v * v * p[1] + 2 * u * v * m[1] + u * u * q[1]]);
      }
      turns.set(a + b, edge(drive, arc, true));
    }
  }
  const walk: NetGraph = { nodes: [], edges: [] };
  const crossing = {} as Record<Arm, number>, sidewalk = {} as Record<Arm, number>;
  for (const a of ARMS) {
    crossing[a] = edge(walk, [along(a, CROSS_AT, WALK_OFF), along(a, CROSS_AT, -WALK_OFF)], false, { crossing: true });
    sidewalk[a] = edge(walk, [along(a, len, -WALK_OFF), along(a, CROSS_AT, -WALK_OFF)], false, { width: opts.walkWidth ?? 3 });
    edge(walk, [along(a, CROSS_AT, WALK_OFF), along(a, len, WALK_OFF)], false);
  }
  ARMS.forEach((a, i) => {
    const b = ARMS[(i + 1) % 4]!;
    edge(walk, [along(a, CROSS_AT, WALK_OFF), along(b, CROSS_AT, -WALK_OFF)], false);
  });
  const group = (a: Arm): 0 | 1 => (a === 'N' || a === 'S' ? 0 : 1);
  const j: JunctionInfo = {
    x: 0, z: 0,
    signal: opts.signal ? { id: 0, offsetTicks: opts.offsetTicks ?? 0, midblock: false } : null,
    approaches: ARMS.map((a) => ({ edge: inLane[a], group: group(a), stopS: len - BOX - 3, rank: opts.ranks?.[a] ?? 2 })),
    turns: [...turns.values()],
    cycleApproaches: ARMS.map((a) => ({ edge: inLane[a], group: group(a), stopS: len - BOX - 3, rank: opts.ranks?.[a] ?? 2 })),
    cycleTurns: [...turns.values()],
    peds: opts.signal ? ARMS.map((a) => ({ walkEdge: crossing[a], group: (1 - group(a)) as 0 | 1 })) : [],
    poles: [], stopLines: [],
  };
  return {
    net: { version: 1, walk, drive, cycle: drive, seats: [], junctions: [j] },
    inLane, outLane, crossing, sidewalk, turn: (a, b) => turns.get(a + b)!, armLength: len,
  };
}
