import type { MapData } from '@nn/shared';
import type { MapGrid } from './grid';
import { placeLabels } from './labels';
import { MAP_STYLE, roadStyle } from './style';
import type { MapView } from './view';

function tracePolyline(ctx: CanvasRenderingContext2D, pts: number[], close: boolean): void {
  if (pts.length < 4) return;
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  if (close) ctx.closePath();
}

function fillPolys(ctx: CanvasRenderingContext2D, polys: number[][], color: string): void {
  if (polys.length === 0) return;
  ctx.beginPath();
  for (const p of polys) tracePolyline(ctx, p, true);
  ctx.fillStyle = color;
  ctx.fill();
}

function fillTriangles(ctx: CanvasRenderingContext2D, tris: number[][], color: string): void {
  if (tris.length === 0) return;
  ctx.fillStyle = color;
  // one path per building: a single huge path makes the nonzero fill (software rasteriser) seconds slow
  for (const t of tris) {
    ctx.beginPath();
    for (let i = 0; i + 5 < t.length; i += 6) {
      ctx.moveTo(t[i]!, t[i + 1]!);
      ctx.lineTo(t[i + 2]!, t[i + 3]!);
      ctx.lineTo(t[i + 4]!, t[i + 5]!);
      ctx.closePath();
    }
    ctx.fill();
  }
}

/**
 * Draws the map into the whole view rectangle (CSS px; any base transform of ctx, e.g. devicePixelRatio, is kept).
 * World-space paths under one transform, batched per style. Labels only on the big map.
 */
export function drawMap(ctx: CanvasRenderingContext2D, data: MapData, grid: MapGrid, v: MapView, opts: { minimap: boolean }): void {
  ctx.save();
  ctx.fillStyle = MAP_STYLE.bg;
  ctx.fillRect(0, 0, v.w, v.h);

  // Axis-aligned box around the visible rectangle's circumcircle: valid for any rotation.
  const r = Math.hypot(v.w, v.h) / 2 / v.scale;
  const items = grid.query(v.cx - r, v.cz - r, v.cx + r, v.cz + r);

  const c = Math.cos(v.rot) * v.scale;
  const s = Math.sin(v.rot) * v.scale;
  ctx.transform(c, s, -s, c, v.w / 2 - (c * v.cx - s * v.cz), v.h / 2 - (s * v.cx + c * v.cz));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  fillPolys(ctx, data.water, MAP_STYLE.water); // a few rings: drawn whole, not via the grid
  fillPolys(ctx, items.greens.map((i) => data.greens[i]!), MAP_STYLE.green);
  fillPolys(ctx, items.squares.map((i) => data.squares[i]!.pts), MAP_STYLE.square);
  fillTriangles(ctx, items.buildings.map((i) => data.buildings[i]!), MAP_STYLE.building);

  // Roads: least important first so main roads end up on top.
  const byKind = new Map<string, number[][]>();
  for (const i of items.roads) {
    const road = data.roads[i]!;
    const list = byKind.get(road.kind);
    if (list) list.push(road.pts);
    else byKind.set(road.kind, [road.pts]);
  }
  const kinds = [...byKind.keys()].map((k) => ({ k, st: roadStyle(k) })).sort((a, b) => b.st.rank - a.st.rank);
  for (const { k, st } of kinds) {
    ctx.beginPath();
    for (const pts of byKind.get(k)!) tracePolyline(ctx, pts, false);
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.widthPx(v.scale) / v.scale;
    ctx.stroke();
  }

  if (items.tram.length > 0) {
    ctx.beginPath();
    for (const i of items.tram) tracePolyline(ctx, data.tram[i]!, false);
    ctx.strokeStyle = MAP_STYLE.tram;
    ctx.lineWidth = 1.5 / v.scale;
    ctx.stroke();
  }

  ctx.beginPath();
  tracePolyline(ctx, data.boundary, true);
  ctx.strokeStyle = MAP_STYLE.boundary;
  ctx.lineWidth = 2 / v.scale;
  ctx.setLineDash([8 / v.scale, 6 / v.scale]);
  ctx.stroke();
  ctx.restore();

  if (opts.minimap) return;

  // Labels in screen space (their angle is already a screen angle).
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  for (const l of placeLabels(data, items, v, (t) => ctx.measureText(t).width)) {
    ctx.save();
    ctx.translate(l.sx, l.sy);
    ctx.rotate(l.angle);
    ctx.strokeStyle = MAP_STYLE.labelHalo;
    ctx.strokeText(l.text, 0, 0);
    ctx.fillStyle = l.kind === 'stop' ? MAP_STYLE.arrow : MAP_STYLE.label;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Player arrow at screen position. angle = screen angle clockwise from up (0 = up, π/2 = right). */
export function drawArrow(ctx: CanvasRenderingContext2D, sx: number, sy: number, angle: number, size: number): void {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.7, size * 0.8);
  ctx.lineTo(0, size * 0.4);
  ctx.lineTo(-size * 0.7, size * 0.8);
  ctx.closePath();
  ctx.fillStyle = MAP_STYLE.arrow;
  ctx.strokeStyle = MAP_STYLE.labelHalo;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

/** Another player on the map: a dot in their colour, optionally with their name beside it. */
export function drawPlayerDot(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number, color: string, name?: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.strokeStyle = MAP_STYLE.labelHalo;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fill();
  if (name) {
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeText(name, sx + r + 4, sy);
    ctx.fillStyle = MAP_STYLE.label;
    ctx.fillText(name, sx + r + 4, sy);
  }
  ctx.restore();
}

/** Stable, distinct colour per player slot. */
export function playerColor(slot: number): string {
  return `hsl(${(slot * 137.5 + 190) % 360} 85% 62%)`;
}
