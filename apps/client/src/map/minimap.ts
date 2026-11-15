import type { MapData } from '@nn/shared';
import { drawArrow, drawMap } from './draw';
import type { MapGrid } from './grid';
import { rotForYaw, worldToScreen, type MapView } from './view';

const SIZE = 180;
const DIAMETER_M = 250;

/** Round, heading-up minimap at the top right; redrawn on every update. */
export class Minimap {
  private readonly box: HTMLDivElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly north: HTMLDivElement;
  private readonly street: HTMLDivElement;
  private readonly dpr = Math.max(1, window.devicePixelRatio || 1);

  constructor(root: HTMLElement, private readonly data: MapData, private readonly grid: MapGrid) {
    this.box = div('nn-minimap', root);
    const disc = div('nn-minimap-disc', this.box);
    const canvas = document.createElement('canvas');
    canvas.className = 'nn-minimap-canvas';
    canvas.width = Math.round(SIZE * this.dpr);
    canvas.height = Math.round(SIZE * this.dpr);
    disc.append(canvas);
    this.ctx = canvas.getContext('2d')!;
    this.north = div('nn-minimap-north', disc);
    this.north.textContent = 'N';
    this.street = div('nn-minimap-street', this.box);
  }

  update(x: number, z: number, yaw: number, street: string): void {
    const v: MapView = { cx: x, cz: z, scale: SIZE / DIAMETER_M, rot: rotForYaw(yaw), w: SIZE, h: SIZE };
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawMap(ctx, this.data, this.grid, v, { minimap: true });
    drawArrow(ctx, SIZE / 2, SIZE / 2, 0, 9);

    // North marker: far point towards -z, projected onto the circle edge.
    const n = worldToScreen(v, x, z - 100000);
    const dx = n.sx - SIZE / 2;
    const dy = n.sy - SIZE / 2;
    const len = Math.hypot(dx, dy) || 1;
    const r = SIZE / 2 - 10;
    this.north.style.left = `${SIZE / 2 + (dx / len) * r}px`;
    this.north.style.top = `${SIZE / 2 + (dy / len) * r}px`;

    if (this.street.textContent !== street) this.street.textContent = street;
  }

  setVisible(v: boolean): void {
    this.box.classList.toggle('nn-hidden', !v);
  }
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.append(e);
  return e;
}
