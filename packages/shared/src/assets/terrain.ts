/** Heights (local y = NHN − datum) at (x0 + c·1 m, z0 + r·1 m); row-major, index r * cols + c. */
export type TerrainGrid = { x0: number; z0: number; cols: number; rows: number; datum: number; heights: Float32Array };

/**
 * Diagonal that splits each 1 m cell into two triangles; heightAt/terrainNormal and the physics heightfield must agree.
 * 'x0z0-x1z1': from cell corner (x0,z0) to (x1,z1); 'x1z0-x0z1': from (x1,z0) to (x0,z1).
 */
export const TERRAIN_DIAGONAL: 'x0z0-x1z1' | 'x1z0-x0z1' = 'x0z0-x1z1';

type Cell = { h: number; gx: number; gz: number };

/** Height and gradient (dh/dx, dh/dz) of the triangle under (x, z); position clamped to the grid. */
function sample(t: TerrainGrid, x: number, z: number): Cell {
  const u = Math.min(Math.max(x - t.x0, 0), t.cols - 1);
  const v = Math.min(Math.max(z - t.z0, 0), t.rows - 1);
  const c = Math.min(Math.floor(u), Math.max(t.cols - 2, 0));
  const r = Math.min(Math.floor(v), Math.max(t.rows - 2, 0));
  const fx = u - c;
  const fz = v - r;
  const c1 = Math.min(c + 1, t.cols - 1);
  const r1 = Math.min(r + 1, t.rows - 1);
  const h00 = t.heights[r * t.cols + c]!;
  const h10 = t.heights[r * t.cols + c1]!;
  const h01 = t.heights[r1 * t.cols + c]!;
  const h11 = t.heights[r1 * t.cols + c1]!;
  if (TERRAIN_DIAGONAL === 'x0z0-x1z1') {
    if (fx >= fz) return { h: h00 + fx * (h10 - h00) + fz * (h11 - h10), gx: h10 - h00, gz: h11 - h10 };
    return { h: h00 + fz * (h01 - h00) + fx * (h11 - h01), gx: h11 - h01, gz: h01 - h00 };
  }
  if (fx + fz <= 1) return { h: h00 + fx * (h10 - h00) + fz * (h01 - h00), gx: h10 - h00, gz: h01 - h00 };
  return { h: h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11), gx: h11 - h01, gz: h11 - h10 };
}

/** Terrain height at local (x, z), linear on the triangle given by TERRAIN_DIAGONAL; clamps to the grid. */
export function heightAt(t: TerrainGrid, x: number, z: number): number {
  return sample(t, x, z).h;
}

/** Unit normal (y > 0) of the triangle under (x, z). */
export function terrainNormal(t: TerrainGrid, x: number, z: number): { x: number; y: number; z: number } {
  const { gx, gz } = sample(t, x, z);
  const len = Math.hypot(gx, 1, gz);
  return { x: -gx / len, y: 1 / len, z: -gz / len };
}

const MAGIC = 'NNT1';
const HEADER = 44; // magic + uint32 cols, rows + float64 x0, z0, datum, base
const MAX_CM = 65535;

/**
 * Layout: 'NNT1', uint32 cols, rows, float64 x0, z0, datum, base (little-endian), then cols·rows uint16 =
 * centimetres above `base` (the minimum height floored to 1 cm). Heights are quantised to 1 cm.
 */
export function encodeTerrain(t: TerrainGrid): ArrayBuffer {
  const n = t.cols * t.rows;
  if (t.heights.length !== n) throw new Error('terrain: heights length does not match cols*rows');
  let min = Infinity;
  for (const h of t.heights) {
    if (!Number.isFinite(h)) throw new Error('terrain: non-finite height');
    if (h < min) min = h;
  }
  const base = n ? Math.floor(min * 100) / 100 : 0;
  const buf = new ArrayBuffer(HEADER + 2 * n);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, t.cols, true);
  view.setUint32(8, t.rows, true);
  view.setFloat64(12, t.x0, true);
  view.setFloat64(20, t.z0, true);
  view.setFloat64(28, t.datum, true);
  view.setFloat64(36, base, true);
  let o = HEADER;
  for (const h of t.heights) {
    const cm = Math.round((h - base) * 100);
    if (cm > MAX_CM) throw new Error('terrain: height span exceeds 655.35 m');
    view.setUint16(o, cm, true);
    o += 2;
  }
  return buf;
}

export function decodeTerrain(buf: ArrayBuffer): TerrainGrid {
  if (buf.byteLength < HEADER) throw new Error('terrain: buffer too short');
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error(`terrain: bad magic ${JSON.stringify(magic)}`);
  const cols = view.getUint32(4, true);
  const rows = view.getUint32(8, true);
  if (buf.byteLength !== HEADER + 2 * cols * rows) throw new Error('terrain: length mismatch');
  const base = view.getFloat64(36, true);
  const heights = new Float32Array(cols * rows);
  for (let i = 0; i < heights.length; i++) heights[i] = base + view.getUint16(HEADER + 2 * i, true) / 100;
  return { x0: view.getFloat64(12, true), z0: view.getFloat64(20, true), cols, rows, datum: view.getFloat64(28, true), heights };
}
