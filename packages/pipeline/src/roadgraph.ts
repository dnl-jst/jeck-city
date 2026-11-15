import type { OsmFeatures, Pt } from './osm.js';
import { dedupe, DRIVABLE, distToPolyline, ptKey } from './polyline.js';

export type RoadGraph = {
  nodes: { id: number; pos: Pt }[];
  edges: { from: number; to: number; roadId: number; lanesForward: number; lanesBackward: number; tram: boolean }[];
  stops: { name: string; pos: Pt; edgeIndex: number }[];
};

const MAX_STOP_DISTANCE = 25;

type Line = { roadId: number; pts: Pt[]; fwd: number; bwd: number; tram: boolean };

/**
 * Edges follow way direction (from -> to); oneway roads have lanesBackward 0.
 * Tram tracks (no OSM id in OsmFeatures) get roadId = -(index + 1) into `tramTracks`; one lane forward.
 */
export function buildRoadGraph(f: OsmFeatures): RoadGraph {
  const lines: Line[] = [];
  for (const r of f.roads) {
    if (!DRIVABLE.has(r.kind) && r.kind !== 'service') continue;
    const pts = dedupe(r.points);
    if (pts.length < 2) continue;
    const fwd = r.oneway ? r.lanes : Math.max(1, Math.ceil(r.lanes / 2));
    const bwd = r.oneway ? 0 : Math.max(1, Math.floor(r.lanes / 2));
    lines.push({ roadId: r.id, pts, fwd, bwd, tram: false });
  }
  f.tramTracks.forEach((t, i) => {
    const pts = dedupe(t);
    if (pts.length >= 2) lines.push({ roadId: -(i + 1), pts, fwd: 1, bwd: 0, tram: true });
  });

  // a vertex is a graph node if it is a way end or shared by more than one occurrence
  const count = new Map<string, number>();
  for (const l of lines) for (const p of l.pts) count.set(ptKey(p), (count.get(ptKey(p)) ?? 0) + 1);

  const graph: RoadGraph = { nodes: [], edges: [], stops: [] };
  const ids = new Map<string, number>();
  const nodeAt = (p: Pt): number => {
    let id = ids.get(ptKey(p));
    if (id === undefined) {
      id = graph.nodes.length;
      ids.set(ptKey(p), id);
      graph.nodes.push({ id, pos: p });
    }
    return id;
  };
  const edgeLines: Pt[][] = [];
  for (const l of lines) {
    let start = 0;
    for (let i = 1; i < l.pts.length; i++) {
      if (i < l.pts.length - 1 && (count.get(ptKey(l.pts[i]!)) ?? 0) < 2) continue;
      graph.edges.push({ from: nodeAt(l.pts[start]!), to: nodeAt(l.pts[i]!), roadId: l.roadId, lanesForward: l.fwd, lanesBackward: l.bwd, tram: l.tram });
      edgeLines.push(l.pts.slice(start, i + 1));
      start = i;
    }
  }

  for (const s of f.tramStops) {
    let best = -1;
    let bestD = MAX_STOP_DISTANCE;
    graph.edges.forEach((e, i) => {
      if (!e.tram) return;
      const d = distToPolyline(s.pos, edgeLines[i]!);
      if (d < bestD) [best, bestD] = [i, d];
    });
    if (best >= 0) graph.stops.push({ name: s.name, pos: s.pos, edgeIndex: best });
  }
  return graph;
}

