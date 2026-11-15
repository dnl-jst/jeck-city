import type { MapData } from '@nn/shared';

export type MapItems = { roads: number[]; buildings: number[]; greens: number[]; squares: number[]; tram: number[] };
type Kind = keyof MapItems;
const KINDS: Kind[] = ['roads', 'buildings', 'greens', 'squares', 'tram'];

/** Uniform grid over feature bounding boxes; query returns indices into MapData lists, without duplicates. */
export class MapGrid {
  private readonly cells = new Map<string, Record<Kind, number[]>>();

  constructor(data: MapData, private readonly cell = 100) {
    data.roads.forEach((r, i) => this.add('roads', i, r.pts));
    data.buildings.forEach((p, i) => this.add('buildings', i, p));
    data.greens.forEach((p, i) => this.add('greens', i, p));
    data.squares.forEach((s, i) => this.add('squares', i, s.pts));
    data.tram.forEach((p, i) => this.add('tram', i, p));
  }

  query(minX: number, minZ: number, maxX: number, maxZ: number): MapItems {
    const out: MapItems = { roads: [], buildings: [], greens: [], squares: [], tram: [] };
    const seen = { roads: new Set<number>(), buildings: new Set<number>(), greens: new Set<number>(), squares: new Set<number>(), tram: new Set<number>() };
    const c = this.cell;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++) {
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const items = this.cells.get(`${i},${j}`);
        if (!items) continue;
        for (const k of KINDS) {
          for (const idx of items[k]) {
            if (!seen[k].has(idx)) { seen[k].add(idx); out[k].push(idx); }
          }
        }
      }
    }
    return out;
  }

  private add(kind: Kind, idx: number, pts: number[]): void {
    if (pts.length < 2) return;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!);
      z0 = Math.min(z0, pts[i + 1]!); z1 = Math.max(z1, pts[i + 1]!);
    }
    const c = this.cell;
    for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++) {
      for (let j = Math.floor(z0 / c); j <= Math.floor(z1 / c); j++) {
        const key = `${i},${j}`;
        let items = this.cells.get(key);
        if (!items) { items = { roads: [], buildings: [], greens: [], squares: [], tram: [] }; this.cells.set(key, items); }
        items[kind].push(idx);
      }
    }
  }
}
