import type { MapData } from '@nn/shared';
import type { MapItems } from './grid';
import { worldToScreen, type MapView } from './view';

export type Label = { text: string; sx: number; sy: number; angle: number; kind: 'road' | 'square' | 'stop' }; // angle in rad, centre of the text

const TEXT_H = 14;
const MARGIN = 4;
const SAME_NAME_DIST = 300;
const FIT = 1.2;
const STOP_OFFSET = 10;

const MAIN = new Set(['primary', 'secondary']);
const MINOR_ROADS = new Set(['tertiary', 'residential', 'unclassified']);

/** Smallest scale (px/m) at which labels of this kind are shown. Road kinds are OSM highway values. */
export function minScaleFor(kind: string): number {
  if (kind === 'square') return 0.8;
  if (kind === 'stop') return 1.0;
  if (MAIN.has(kind)) return 0;
  if (MINOR_ROADS.has(kind)) return 0.6;
  return 1.5;
}

const rank = (kind: string): number => (MAIN.has(kind) ? (kind === 'primary' ? 0 : 1) : MINOR_ROADS.has(kind) ? 2 : 3);

type Box = { x: number; y: number; hw: number; hh: number; c: number; s: number };

function boxOf(sx: number, sy: number, angle: number, textW: number): Box {
  return { x: sx, y: sy, hw: textW / 2 + MARGIN / 2, hh: TEXT_H / 2 + MARGIN / 2, c: Math.cos(angle), s: Math.sin(angle) };
}

/** Separating-axis test for two oriented boxes. */
function intersects(a: Box, b: Box): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [ax, ay] of [[a.c, a.s], [-a.s, a.c], [b.c, b.s], [-b.s, b.c]] as const) {
    const proj = (q: Box) => q.hw * Math.abs(q.c * ax + q.s * ay) + q.hh * Math.abs(-q.s * ax + q.c * ay);
    if (Math.abs(dx * ax + dy * ay) > proj(a) + proj(b)) return false;
  }
  return true;
}

/** Direction of a segment folded into (-PI/2, PI/2] so text is never upside down. */
function readableAngle(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

type Candidate = { text: string; sx: number; sy: number; angle: number; w: number; kind: Label['kind']; rank: number; len: number };

export function placeLabels(data: MapData, items: MapItems, v: MapView, measure: (text: string) => number): Label[] {
  const onScreen = (sx: number, sy: number) => sx >= 0 && sy >= 0 && sx <= v.w && sy <= v.h;
  const cands: Candidate[] = [];

  if (v.scale >= minScaleFor('stop')) {
    for (const s of data.tramStops) {
      if (!s.name) continue;
      const p = worldToScreen(v, s.x, s.z);
      if (onScreen(p.sx, p.sy)) cands.push({ text: s.name, sx: p.sx, sy: p.sy - STOP_OFFSET, angle: 0, w: measure(s.name), kind: 'stop', rank: -2, len: 0 });
    }
  }

  if (v.scale >= minScaleFor('square')) {
    for (const i of items.squares) {
      const sq = data.squares[i]!;
      if (!sq.name || sq.pts.length < 2) continue;
      let mx = 0, mz = 0;
      const n = sq.pts.length / 2;
      for (let k = 0; k < sq.pts.length; k += 2) { mx += sq.pts[k]!; mz += sq.pts[k + 1]!; }
      const p = worldToScreen(v, mx / n, mz / n);
      if (onScreen(p.sx, p.sy)) cands.push({ text: sq.name, sx: p.sx, sy: p.sy, angle: 0, w: measure(sq.name), kind: 'square', rank: -1, len: 0 });
    }
  }

  for (const i of items.roads) {
    const r = data.roads[i]!;
    if (!r.name || v.scale < minScaleFor(r.kind)) continue;
    const w = measure(r.name);
    let best: { sx: number; sy: number; angle: number; len: number } | null = null;
    let total = 0;
    let prev = worldToScreen(v, r.pts[0]!, r.pts[1]!);
    for (let k = 2; k < r.pts.length; k += 2) {
      const p = worldToScreen(v, r.pts[k]!, r.pts[k + 1]!);
      const dx = p.sx - prev.sx;
      const dy = p.sy - prev.sy;
      const len = Math.hypot(dx, dy);
      total += len;
      const mx = (p.sx + prev.sx) / 2;
      const my = (p.sy + prev.sy) / 2;
      if (len >= FIT * w && onScreen(mx, my) && (!best || len > best.len)) best = { sx: mx, sy: my, angle: readableAngle(dx, dy), len };
      prev = p;
    }
    if (best) cands.push({ text: r.name, sx: best.sx, sy: best.sy, angle: best.angle, w, kind: 'road', rank: rank(r.kind), len: total });
  }

  cands.sort((a, b) => a.rank - b.rank || b.len - a.len);

  const placed: Label[] = [];
  const boxes: Box[] = [];
  const byName = new Map<string, Label[]>();
  for (const c of cands) {
    if (c.kind === 'road' && byName.get(c.text)?.some((o) => Math.hypot(o.sx - c.sx, o.sy - c.sy) < SAME_NAME_DIST)) continue;
    const box = boxOf(c.sx, c.sy, c.angle, c.w);
    if (boxes.some((b) => intersects(b, box))) continue;
    const label: Label = { text: c.text, sx: c.sx, sy: c.sy, angle: c.angle, kind: c.kind };
    placed.push(label);
    boxes.push(box);
    if (c.kind === 'road') (byName.get(c.text) ?? byName.set(c.text, []).get(c.text)!).push(label);
  }
  return placed;
}
