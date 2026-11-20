import { wgs84ToLocal } from '@nn/shared';
import type { Pt } from './osm.js';

/**
 * The Stadtbahn network from OpenStreetMap: every line's way through the play area (route relations: their track
 * ways and stops in travel order, see fetch.ts TRANSIT_ROUTES_QUERY; the ways' geometry comes from osm.json).
 */
export type Route = {
  /** Line number and the termini as OSM names them. */
  ref: string; from: string; to: string;
  /** The track through the area in travel order (ways joined end to end), and per point where it runs. */
  pts: Pt[];
  /** Per point: 'tunnel', 'bridge' or 'surface', and the OSM layer (0 on the ground, −2 a deep tunnel, 1 a bridge). */
  kind: ('tunnel' | 'bridge' | 'surface')[];
  layer: number[];
  /** Stops in travel order: name, distance along `pts` (m) and the stop's own position. */
  stops: { name: string; s: number; x: number; z: number }[];
  /** The OSM ways the track is made of, in travel order; reversed: travelled against the way's own direction. */
  parts: { way: number; reversed: boolean }[];
};

/** A track way of the network as OSM has it (see railWays). */
export type RailWay = { id: number; pts: Pt[]; kind: 'tunnel' | 'bridge' | 'surface'; layer: number };

/** Every tram / light rail way of the OSM data by id. */
export function railWays(osm: unknown): Map<number, RailWay> {
  const out = new Map<number, RailWay>();
  for (const e of ((osm as { elements?: El[] }).elements ?? [])) {
    if (e.type !== 'way' || !e.geometry || !(e.tags?.railway === 'tram' || e.tags?.railway === 'light_rail' || e.tags?.railway === 'subway')) continue;
    const tags = e.tags;
    out.set(e.id, {
      id: e.id, pts: e.geometry.map((g) => wgs84ToLocal(g.lat, g.lon)),
      kind: tags.tunnel === 'yes' ? 'tunnel' : tags.bridge && tags.bridge !== 'no' ? 'bridge' : 'surface', layer: Number(tags.layer ?? 0) || 0,
    });
  }
  return out;
}

type LL = { lat: number; lon: number };
type El = { type: string; id: number; lat?: number; lon?: number; geometry?: LL[]; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[] };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Routes from the two Overpass results. Ways of a relation that are not in osm.json lie outside the fetched area: a
 * route is the longest run of consecutive ways that are. Ways that do not join the one before (a gap in the relation)
 * end the run.
 */
export function parseRoutes(osm: unknown, routes: unknown): Route[] {
  const ways = new Map<number, El>(), nodes = new Map<number, El>();
  for (const e of ((osm as { elements?: El[] }).elements ?? [])) {
    if (e.type === 'way' && e.geometry && (e.tags?.railway === 'tram' || e.tags?.railway === 'light_rail' || e.tags?.railway === 'subway')) ways.set(e.id, e);
    else if (e.type === 'node' && e.lat !== undefined && e.tags?.name) nodes.set(e.id, e);
  }
  const out: Route[] = [];
  for (const r of ((routes as { elements?: El[] }).elements ?? [])) {
    if (r.type !== 'relation' || !r.members) continue;
    const t = r.tags ?? {};
    // runs of consecutive track ways that are in the area and join end to end
    type Piece = { pts: Pt[]; kind: Route['kind'][number]; layer: number; way: number; reversed: boolean };
    const runs: Piece[][] = [];
    let run: Piece[] = [];
    const close = () => { if (run.length) runs.push(run); run = []; };
    for (const m of r.members) {
      if (m.type !== 'way' || /platform/.test(m.role)) continue;
      const w = ways.get(m.ref);
      if (!w) { close(); continue; }
      const tags = w.tags ?? {}, pts = w.geometry!.map((g) => wgs84ToLocal(g.lat, g.lon));
      const piece: Piece = { pts, kind: tags.tunnel === 'yes' ? 'tunnel' : tags.bridge && tags.bridge !== 'no' ? 'bridge' : 'surface', layer: Number(tags.layer ?? 0) || 0, way: w.id, reversed: false };
      const prev = run[run.length - 1];
      if (prev) {
        // turn the new way (and, for the second way of a run, the first one) so that they meet
        const ends = [prev.pts[0]!, prev.pts[prev.pts.length - 1]!], mine = [pts[0]!, pts[pts.length - 1]!];
        let best = { d: Infinity, a: 1, b: 0 };
        for (const a of [0, 1]) for (const b of [0, 1]) { const d = dist(ends[a]!, mine[b]!); if (d < best.d) best = { d, a, b }; }
        if (best.d > 1) close();
        else {
          if (best.a === 0) { if (run.length === 1) { prev.pts.reverse(); prev.reversed = true; } else { close(); } }
          if (run.length && best.b === 1) { piece.pts.reverse(); piece.reversed = true; }
        }
      }
      run.push(piece);
    }
    close();
    const longest = runs.sort((a, b) => length(b) - length(a))[0];
    if (!longest) continue;
    const pts: Pt[] = [], kind: Route['kind'] = [], layer: number[] = [];
    for (const p of longest) {
      for (const [i, q] of p.pts.entries()) {
        if (i === 0 && pts.length) continue; // shared with the way before
        pts.push(q);
        kind.push(p.kind);
        layer.push(p.layer);
      }
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
    const stops: Route['stops'] = [];
    for (const m of r.members) {
      if (m.type !== 'node' || !/^stop/.test(m.role)) continue;
      const n = nodes.get(m.ref);
      if (!n) continue;
      const p = wgs84ToLocal(n.lat!, n.lon!);
      // where on the track: the nearest point of the path, if the stop lies on it
      let best = Infinity, s = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!, ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
        const u = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ex + (p.z - a.z) * ez) / l2)) : 0;
        const d = Math.hypot(a.x + ex * u - p.x, a.z + ez * u - p.z);
        if (d < best) { best = d; s = cum[i - 1]! + Math.sqrt(l2) * u; }
      }
      if (best > 15) continue;
      const name = n.tags!.name!;
      if (stops[stops.length - 1]?.name !== name) stops.push({ name, s: Math.round(s * 10) / 10, x: p.x, z: p.z });
    }
    stops.sort((a, b) => a.s - b.s);
    out.push({ ref: t.ref ?? '', from: t.from ?? '', to: t.to ?? '', pts, kind, layer, stops, parts: longest.map((p) => ({ way: p.way, reversed: p.reversed })) });
  }
  return out.sort((a, b) => Number(a.ref) - Number(b.ref) || a.to.localeCompare(b.to));
}

function length(run: { pts: Pt[] }[]): number {
  let n = 0;
  for (const p of run) for (let i = 1; i < p.pts.length; i++) n += dist(p.pts[i - 1]!, p.pts[i]!);
  return n;
}
