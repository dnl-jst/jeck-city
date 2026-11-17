import type { NetGraph, NpcNet, SeatRing } from '../npc/netgraph';

/**
 * Test helper: a 600 × 600 m grid city (blocks of `block` m, centred on the origin). Walk and cycle: every grid line
 * two-way; drive: every grid line as two one-way edges, one per direction; a park of 10 seat rings near (205, 0).
 */
export function gridNet(size = 600, block = 50): NpcNet {
  const n = Math.round(size / block) + 1;
  const h = size / 2;
  const nodes: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) nodes.push([-h + i * block, -h + k * block]);
  const id = (i: number, k: number) => i * n + k;
  const two: NetGraph = { nodes, edges: [] };
  const one: NetGraph = { nodes, edges: [] };
  const seg = (a: number, b: number) => [nodes[a]!, nodes[b]!] as [number, number][];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      for (const [di, dk] of [[1, 0], [0, 1]] as const) {
        if (i + di >= n || k + dk >= n) continue;
        const a = id(i, k), b = id(i + di, k + dk);
        two.edges.push({ a, b, pts: seg(a, b), width: 3, oneway: false });
        one.edges.push({ a, b, pts: seg(a, b), width: 3, oneway: true });
        one.edges.push({ a: b, b: a, pts: seg(b, a), width: 3, oneway: true });
      }
    }
  }
  const seats: SeatRing[] = Array.from({ length: 10 }, (_, j) => {
    const x = 190 + (j % 5) * 8, z = -10 + Math.floor(j / 5) * 20;
    return {
      x, z, bench: false,
      seats: [0, 1, 2].map((q) => {
        const a = (q / 3) * Math.PI * 2;
        const sx = x + Math.sin(a) * 0.9, sz = z + Math.cos(a) * 0.9;
        return { x: sx, z: sz, heading: Math.atan2(x - sx, z - sz) };
      }),
    };
  });
  return { version: 1, walk: two, cycle: two, drive: one, seats, junctions: [] };
}
