import type { MapData } from '@nn/shared';
import { drawArrow, drawMap } from './draw';
import type { MapGrid } from './grid';
import { clampView, panBy, worldToScreen, zoomBy, type MapView } from './view';

const MOVED_M = 0.5;
const TURNED_RAD = (2 * Math.PI) / 180;

/** Full-screen map overlay, north up. Redraws only when the view or the player changed noticeably. */
export class BigMap {
  private readonly box: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private view: MapView = { cx: 0, cz: 0, scale: 1, rot: 0, w: 1, h: 1 };
  private drawn: { view: MapView; x: number; z: number; yaw: number } | null = null;
  private isOpen = false;

  constructor(root: HTMLElement, private readonly data: MapData, private readonly grid: MapGrid) {
    this.box = document.createElement('div');
    this.box.className = 'nn-bigmap nn-hidden';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'nn-bigmap-canvas';
    const hint = document.createElement('div');
    hint.className = 'nn-bigmap-hint';
    hint.textContent = 'M / Esc schließen · Maus verschieben · Mausrad zoomen';
    this.box.append(this.canvas, hint);
    root.append(this.box);
    this.ctx = this.canvas.getContext('2d')!;
  }

  open(x: number, z: number): void {
    this.isOpen = true;
    this.box.classList.remove('nn-hidden');
    this.view = clampView({ cx: x, cz: z, scale: 1, rot: 0, w: 1, h: 1 }, this.data.bounds);
    this.resize();
  }

  /** Sizes canvas and view to the window and forces a redraw. */
  private resize(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.view = clampView({ ...this.view, w, h }, this.data.bounds);
    this.drawn = null;
  }

  close(): void {
    this.isOpen = false;
    this.box.classList.add('nn-hidden');
  }

  update(input: { dx: number; dy: number; notches: number }, player: { x: number; z: number; yaw: number }): void {
    if (!this.isOpen) return;
    if (window.innerWidth !== this.view.w || window.innerHeight !== this.view.h) this.resize();
    let v = this.view;
    if (input.dx !== 0 || input.dy !== 0) v = panBy(v, input.dx, input.dy);
    if (input.notches !== 0) v = zoomBy(v, input.notches);
    v = clampView(v, this.data.bounds);
    this.view = v;

    const d = this.drawn;
    const same = d !== null && d.view.cx === v.cx && d.view.cz === v.cz && d.view.scale === v.scale;
    if (same && Math.hypot(player.x - d.x, player.z - d.z) <= MOVED_M && Math.abs(angleDiff(player.yaw, d.yaw)) <= TURNED_RAD) return;
    this.drawn = { view: v, x: player.x, z: player.z, yaw: player.yaw };

    const dpr = this.canvas.width / v.w;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMap(ctx, this.data, this.grid, v, { minimap: false });
    const p = worldToScreen(v, player.x, player.z);
    drawArrow(ctx, p.sx, p.sy, Math.PI - player.yaw, 11);
  }
}

function angleDiff(a: number, b: number): number {
  const d = (a - b) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
}
