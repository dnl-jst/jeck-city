import { describe, expect, it } from 'vitest';
import { clampView, MAX_SCALE, panBy, rotForYaw, screenToWorld, worldToScreen, zoomBy, type MapView } from './view';

const v: MapView = { cx: 100, cz: 200, scale: 2, rot: 0, w: 400, h: 300 };

describe('map view', () => {
  it('north-up: z grows downwards', () => {
    const down = worldToScreen(v, v.cx, v.cz + 10);
    const right = worldToScreen(v, v.cx + 10, v.cz);
    expect(down.sy).toBeGreaterThan(v.h / 2);
    expect(right.sx).toBeGreaterThan(v.w / 2);
  });
  it('rotForYaw puts the view direction up', () => {
    for (const yaw of [0, Math.PI / 2, -2]) {
      const p = worldToScreen({ ...v, rot: rotForYaw(yaw) }, v.cx + 10 * Math.sin(yaw), v.cz + 10 * Math.cos(yaw));
      expect(p.sx).toBeCloseTo(v.w / 2);
      expect(p.sy).toBeCloseTo(v.h / 2 - 10 * v.scale);
    }
  });
  it('screenToWorld inverts worldToScreen', () => {
    const r = { ...v, rot: 1.1 };
    for (const [x, z] of [[0, 0], [150, 230], [-40, 500]] as [number, number][]) {
      const s = worldToScreen(r, x, z);
      const w = screenToWorld(r, s.sx, s.sy);
      expect(w.x).toBeCloseTo(x);
      expect(w.z).toBeCloseTo(z);
    }
  });
  it('zoomBy keeps the centre and multiplies scale', () => {
    const a = zoomBy(v, -1);
    expect(a.scale).toBeCloseTo(v.scale * 1.25);
    expect([a.cx, a.cz]).toEqual([v.cx, v.cz]);
    expect(zoomBy(v, 2).scale).toBeCloseTo(v.scale / 1.5625);
  });
  it('panBy moves content with the mouse', () => {
    const p = panBy(v, 50, 0);
    expect(worldToScreen(p, v.cx, v.cz).sx).toBeCloseTo(v.w / 2 + 50);
    expect(worldToScreen(p, v.cx, v.cz).sy).toBeCloseTo(v.h / 2);
  });
});

describe('clampView', () => {
  const b = { minX: 0, minZ: 0, maxX: 1000, maxZ: 500 };
  const fit = Math.min(400 / 1000, 300 / 500);
  it('limits zoom', () => {
    expect(clampView({ ...v, scale: 0.01 }, b).scale).toBeCloseTo(fit);
    expect(clampView({ ...v, scale: 99 }, b).scale).toBe(MAX_SCALE);
    expect(clampView({ ...v, scale: 1 }, b).scale).toBe(1);
  });
  it('lets MAX_SCALE win when fit exceeds it', () => {
    expect(clampView({ ...v, w: 100000, h: 100000, scale: 1 }, b).scale).toBe(MAX_SCALE);
  });
  it('keeps the centre inside bounds', () => {
    const c = clampView({ ...v, cx: -50, cz: 900 }, b);
    expect([c.cx, c.cz]).toEqual([0, 500]);
  });
});
