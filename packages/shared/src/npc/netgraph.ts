/**
 * The NPC network (npc.json, written by the pipeline): walking, driving and cycling graphs and seat rings in parks.
 * Coordinates are world x/z in metres; heights come from the server's collision (see NpcDirector).
 */
export type NetLayer = 'walk' | 'drive' | 'cycle';
export const NET_LAYERS: readonly NetLayer[] = ['walk', 'drive', 'cycle'];

/**
 * An edge from node a to node b along pts (pts[0] at a, the last at b). width: usable width (m; for stepping around
 * people); oneway: only a → b; crossing: crosses a carriageway (walkers only cross here).
 */
export type NetEdge = { a: number; b: number; pts: [number, number][]; width: number; oneway: boolean; crossing?: boolean };
export type NetGraph = { nodes: [number, number][]; edges: NetEdge[] };

/** Seats of a group in a park: centre and seats (position, heading towards the centre); bench: on an OSM bench. */
export type SeatRing = { x: number; z: number; seats: { x: number; z: number; heading: number }[]; bench: boolean };

export type NpcNet = { version: 1; walk: NetGraph; drive: NetGraph; cycle: NetGraph; seats: SeatRing[] };

const fail = (what: string): never => {
  throw new Error(`npc.json: ${what}`);
};
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

function parseGraph(v: unknown, name: string): NetGraph {
  const g = v as NetGraph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return fail(`${name} is not a graph`);
  if (!g.nodes.every(isPt)) fail(`${name}.nodes`);
  g.edges.forEach((e, i) => {
    const ok = e && Number.isInteger(e.a) && Number.isInteger(e.b) && e.a >= 0 && e.b >= 0 && e.a < g.nodes.length && e.b < g.nodes.length
      && Array.isArray(e.pts) && e.pts.length >= 2 && e.pts.every(isPt) && isNum(e.width) && typeof e.oneway === 'boolean';
    if (!ok) fail(`${name}.edges[${i}]`);
  });
  return g;
}

/** The NPC network from parsed JSON; throws on anything malformed. */
export function parseNpcNet(json: unknown): NpcNet {
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return fail('not an object');
  if (o.version !== 1) fail(`unknown version ${String(o.version)}`);
  const seats = o.seats as SeatRing[];
  if (!Array.isArray(seats) || !seats.every((s) => s && isNum(s.x) && isNum(s.z) && Array.isArray(s.seats) && s.seats.every((q) => isNum(q.x) && isNum(q.z) && isNum(q.heading)))) fail('seats');
  return { ...(o as object), version: 1, walk: parseGraph(o.walk, 'walk'), drive: parseGraph(o.drive, 'drive'), cycle: parseGraph(o.cycle, 'cycle'), seats } as NpcNet;
}

const CELL = 50;

/** Lookups on one graph: edges leaving a node, the nearest edge to a point (50 m grid). */
export class GraphIndex {
  private readonly outs: number[][];
  private readonly cells = new Map<string, number[]>();
  /** Per edge: cumulative lengths of its points. */
  readonly cum: number[][];

  constructor(readonly g: NetGraph) {
    this.outs = g.nodes.map(() => []);
    g.edges.forEach((e, i) => {
      this.outs[e.a]!.push(i);
      if (!e.oneway && e.b !== e.a) this.outs[e.b]!.push(i);
    });
    this.cum = g.edges.map((e) => {
      const c = [0];
      for (let k = 1; k < e.pts.length; k++) c.push(c[k - 1]! + Math.hypot(e.pts[k]![0] - e.pts[k - 1]![0], e.pts[k]![1] - e.pts[k - 1]![1]));
      return c;
    });
    g.edges.forEach((e, i) => {
      const keys = new Set<string>();
      for (let k = 1; k < e.pts.length; k++) {
        const [x0, z0] = e.pts[k - 1]!, [x1, z1] = e.pts[k]!;
        for (let cx = Math.floor(Math.min(x0, x1) / CELL); cx <= Math.floor(Math.max(x0, x1) / CELL); cx++) {
          for (let cz = Math.floor(Math.min(z0, z1) / CELL); cz <= Math.floor(Math.max(z0, z1) / CELL); cz++) keys.add(`${cx},${cz}`);
        }
      }
      for (const k of keys) {
        const l = this.cells.get(k);
        if (l) l.push(i);
        else this.cells.set(k, [i]);
      }
    });
  }

  /** Edges that can be taken from `node` (one-way edges only from their a). */
  out(node: number): number[] {
    return this.outs[node] ?? [];
  }

  /** Length of edge i (m). */
  length(i: number): number {
    const c = this.cum[i]!;
    return c[c.length - 1]!;
  }

  /** Edges with a segment in the grid cells within r of (x, z). */
  near(x: number, z: number, r: number): number[] {
    const out = new Set<number>();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) for (const i of this.cells.get(`${cx},${cz}`) ?? []) out.add(i);
    }
    return [...out];
  }

  /** The edge nearest to (x, z) within maxD (default 50 m): its index, the distance along it (s) and from it (d). */
  nearestEdge(x: number, z: number, maxD = CELL): { edge: number; s: number; d: number } | null {
    let best: { edge: number; s: number; d: number } | null = null;
    for (const i of this.near(x, z, maxD)) {
      const e = this.g.edges[i]!, c = this.cum[i]!;
      for (let k = 1; k < e.pts.length; k++) {
        const [ax, az] = e.pts[k - 1]!, [bx, bz] = e.pts[k]!;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
        const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
        if (d <= maxD && (!best || d < best.d)) best = { edge: i, s: c[k - 1]! + t * Math.sqrt(l2), d };
      }
    }
    return best;
  }
}
