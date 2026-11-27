/** Side of a page in cells. */
export const PAGE = 256;

/**
 * A raster of cols × rows cells kept in pages of PAGE × PAGE cells, allocated on the first `set` into them (and filled
 * with `fill`). Cells of pages never written read `fill`. A value is stored as the page type stores it (a
 * Float32Array page rounds to Float32, exactly like assigning into a Float32Array grid).
 * Pages are addressed by (page column, page row), never by a flat cell index, so cols·rows may exceed 2^31.
 * Cell coordinates must be integers; out-of-range coordinates throw a RangeError.
 */
export class SparseRaster<A extends Float32Array | Uint8Array> {
  readonly cols: number;
  readonly rows: number;
  /** Pages per row and column of pages. */
  readonly pageCols: number;
  readonly pageRows: number;
  private readonly data: (A | undefined)[];

  constructor(cols: number, rows: number, private readonly make: (n: number) => A, private readonly fill: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 0 || rows < 0) throw new RangeError(`sparse raster: bad size ${cols} × ${rows}`);
    this.cols = cols;
    this.rows = rows;
    this.pageCols = Math.ceil(cols / PAGE);
    this.pageRows = Math.ceil(rows / PAGE);
    this.data = new Array<A | undefined>(this.pageCols * this.pageRows);
  }

  private check(c: number, r: number): void {
    if (!(c >= 0 && c < this.cols && r >= 0 && r < this.rows)) throw new RangeError(`sparse raster: cell (${c}, ${r}) outside ${this.cols} × ${this.rows}`);
  }

  get(c: number, r: number): number {
    this.check(c, r);
    const p = this.data[Math.floor(r / PAGE) * this.pageCols + Math.floor(c / PAGE)];
    return p === undefined ? this.fill : p[(r % PAGE) * PAGE + (c % PAGE)]!;
  }

  set(c: number, r: number, v: number): void {
    this.check(c, r);
    const i = Math.floor(r / PAGE) * this.pageCols + Math.floor(c / PAGE);
    let p = this.data[i];
    if (p === undefined) {
      p = this.make(PAGE * PAGE);
      if (p.length !== PAGE * PAGE) throw new Error(`sparse raster: make(${PAGE * PAGE}) returned ${p.length} cells`);
      if (this.fill !== 0) p.fill(this.fill);
      this.data[i] = p;
    }
    p[(r % PAGE) * PAGE + (c % PAGE)] = v;
  }

  /** True once the cell's page exists. */
  has(c: number, r: number): boolean {
    this.check(c, r);
    return this.data[Math.floor(r / PAGE) * this.pageCols + Math.floor(c / PAGE)] !== undefined;
  }

  /** The page (page column pc, page row pr) or undefined; cell (c, r) is at [(r % PAGE) * PAGE + c % PAGE]. */
  page(pc: number, pr: number): A | undefined {
    if (!(pc >= 0 && pc < this.pageCols && pr >= 0 && pr < this.pageRows)) throw new RangeError(`sparse raster: page (${pc}, ${pr}) outside`);
    return this.data[pr * this.pageCols + pc];
  }

  /** Allocated pages in row-major page order: [page column, page row, data]. */
  *pages(): Iterable<[number, number, A]> {
    for (let pr = 0; pr < this.pageRows; pr++)
      for (let pc = 0; pc < this.pageCols; pc++) {
        const p = this.data[pr * this.pageCols + pc];
        if (p !== undefined) yield [pc, pr, p];
      }
  }
}
