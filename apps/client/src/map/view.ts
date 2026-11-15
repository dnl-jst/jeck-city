import type { MapData } from '@nn/shared';

/** Screen origin top-left, (w/2, h/2) = world (cx, cz). scale in px/m; rot 0 = north up. */
export type MapView = { cx: number; cz: number; scale: number; rot: number; w: number; h: number };

export const ZOOM_STEP = 1.25;
export const MAX_SCALE = 4;

/** Rotation that makes the heading (sin yaw, cos yaw) point up on screen. */
export function rotForYaw(yaw: number): number {
  return yaw + Math.PI;
}

export function worldToScreen(v: MapView, x: number, z: number): { sx: number; sy: number } {
  const dx = (x - v.cx) * v.scale;
  const dz = (z - v.cz) * v.scale;
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  return { sx: v.w / 2 + dx * c - dz * s, sy: v.h / 2 + dx * s + dz * c };
}

export function screenToWorld(v: MapView, sx: number, sy: number): { x: number; z: number } {
  const px = sx - v.w / 2;
  const py = sy - v.h / 2;
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  return { x: v.cx + (px * c + py * s) / v.scale, z: v.cz + (-px * s + py * c) / v.scale };
}

/** Positive notches (wheel deltaY > 0) zoom out. */
export function zoomBy(v: MapView, notches: number): MapView {
  return { ...v, scale: v.scale * Math.pow(ZOOM_STEP, -notches) };
}

/** Content follows the mouse: the world point under the cursor moves by (dx, dy) screen pixels. */
export function panBy(v: MapView, dx: number, dy: number): MapView {
  const c = screenToWorld(v, v.w / 2 - dx, v.h / 2 - dy);
  return { ...v, cx: c.x, cz: c.z };
}

/** Scale within [fit, MAX_SCALE] (fit = whole map visible; MAX_SCALE wins if fit is larger), centre within bounds. */
export function clampView(v: MapView, b: MapData['bounds']): MapView {
  const fit = Math.min(v.w / (b.maxX - b.minX), v.h / (b.maxZ - b.minZ));
  const scale = Math.min(MAX_SCALE, Math.max(fit, v.scale));
  return {
    ...v,
    scale,
    cx: Math.min(b.maxX, Math.max(b.minX, v.cx)),
    cz: Math.min(b.maxZ, Math.max(b.minZ, v.cz)),
  };
}
