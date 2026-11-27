import { CHUNK_SIZE } from '@nn/shared';
import type { Rect } from './chunks.js';
import { DrapeOut, drapeTriangle } from './drape.js';
import type { Mesh } from './streets.js';
import type { Heights } from './terrain/height.js';

/**
 * Draping street meshes chunk by chunk instead of for the whole world at once. The result for a chunk is the same,
 * byte for byte, as cropping, draping the whole mesh and splitting it into chunks (splitMesh), because:
 * - drapeMesh welds vertices only within one source triangle and numbers them by first use, and splitMesh renumbers
 *   per chunk by first use, so a chunk's mesh only depends on the order of its pieces;
 * - every piece of a source triangle lies within the triangle's xz bounding box, so the source triangles whose box
 *   touches a chunk are all that can put pieces into it; draped in global order (with marks: group by group in
 *   first-appearance order), their pieces with centroid in the chunk come out in the global order.
 */

/** A flat street mesh prepared for chunk-wise draping: its cropped source triangles, bucketed by the chunks their xz bbox touches. */
export type FlatSource = { mesh: Mesh; trianglesByChunk: Map<string, Uint32Array>; markOrder?: number[] };

/**
 * Slack on the bounding boxes. Zero would already suffice: float32 snapping keeps every piece inside its source
 * triangle's bbox. The slack only widens the candidate set (a triangle that cannot put a piece into a chunk yields no
 * piece there), so no slack value can change the output.
 */
const BOX_SLACK = 0.01;

const inRect = (r: Rect, x: number, z: number) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/** Triangles of `m` whose centroid lies in `r` (OSM ways reach far beyond the world area; no need to drape those). */
export function cropMesh(m: Mesh, r: Rect): Mesh {
  const P = m.positions;
  const idx: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const x = (P[a * 3]! + P[b * 3]! + P[c * 3]!) / 3, z = (P[a * 3 + 2]! + P[b * 3 + 2]! + P[c * 3 + 2]!) / 3;
    if (inRect(r, x, z)) idx.push(a, b, c);
  }
  return { positions: m.positions, uv: m.uv, indices: Uint32Array.from(idx), ...(m.mark ? { mark: m.mark } : {}) };
}

/**
 * Crops `mesh` to `area` and buckets its triangles by chunk. With `mark`, the triangles are put in drapeMesh's
 * order: grouped by mark value, groups in the order of first appearance over the cropped mesh (`markOrder`).
 */
export function prepareFlat(mesh: Mesh, area: Rect): FlatSource {
  const crop = cropMesh(mesh, area);
  let markOrder: number[] | undefined;
  if (crop.mark) {
    // the same grouping as drapeMarked (a Map: first appearance, -0 and 0 in one group)
    const groups = new Map<number, number[]>();
    for (let i = 0; i < crop.indices.length; i += 3) {
      const v = crop.mark[crop.indices[i]!]!;
      let g = groups.get(v);
      if (!g) groups.set(v, (g = []));
      g.push(crop.indices[i]!, crop.indices[i + 1]!, crop.indices[i + 2]!);
    }
    markOrder = [...groups.keys()];
    crop.indices = Uint32Array.from([...groups.values()].flat());
  }
  const P = crop.positions;
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < crop.indices.length / 3; t++) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const n = crop.indices[t * 3 + k]!;
      minX = Math.min(minX, P[n * 3]!);
      maxX = Math.max(maxX, P[n * 3]!);
      minZ = Math.min(minZ, P[n * 3 + 2]!);
      maxZ = Math.max(maxZ, P[n * 3 + 2]!);
    }
    const ix1 = Math.floor((maxX + BOX_SLACK) / CHUNK_SIZE), iz1 = Math.floor((maxZ + BOX_SLACK) / CHUNK_SIZE);
    for (let iz = Math.floor((minZ - BOX_SLACK) / CHUNK_SIZE); iz <= iz1; iz++) {
      for (let ix = Math.floor((minX - BOX_SLACK) / CHUNK_SIZE); ix <= ix1; ix++) {
        const key = `${ix}_${iz}`;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(t);
      }
    }
  }
  const trianglesByChunk = new Map<string, Uint32Array>();
  for (const [key, list] of buckets) trianglesByChunk.set(key, Uint32Array.from(list));
  return { mesh: crop, trianglesByChunk, ...(markOrder ? { markOrder } : {}) };
}

/**
 * The draped part of `src` that belongs to chunk (ix, iz): byte-identical to
 * splitMesh(drapeMesh(cropMesh(mesh, area), terrain), area).get(key).
 * `terrain`: the whole grid, or a TerrainSampler of its file (best with the chunk's window as its fast path: vertical
 * faces are draped whole and may reach beyond any window, those points go to the file).
 */
export function drapeChunk(src: FlatSource, terrain: Heights, ix: number, iz: number, area: Rect): Mesh | undefined {
  const list = src.trianglesByChunk.get(`${ix}_${iz}`);
  if (!list) return undefined;
  const m = src.mesh;
  const window = { minX: ix * CHUNK_SIZE, minZ: iz * CHUNK_SIZE, maxX: (ix + 1) * CHUNK_SIZE, maxZ: (iz + 1) * CHUNK_SIZE };
  const out = new DrapeOut(terrain);
  /** piece vertex (numbered per source triangle) → chunk vertex */
  const remap = new Map<number, number>();
  const pos: number[] = [], uv: number[] = [], mark: number[] = [], idx: number[] = [];
  const f = Math.fround;
  for (const t of list) {
    out.reset();
    drapeTriangle(m, t * 3, terrain, out, window);
    remap.clear();
    // drapeMarked puts its group's value (a Map key: -0 becomes 0) on every vertex
    const raw = m.mark ? m.mark[m.indices[t * 3]!]! : 0;
    const markValue = raw === 0 ? 0 : raw;
    const p = out.pos;
    for (let j = 0; j < out.idx.length; j += 3) {
      const [a, b, c] = [out.idx[j]!, out.idx[j + 1]!, out.idx[j + 2]!];
      // the centroid from the float32 positions, as splitMesh computes it on the draped mesh
      const cx = (f(p[a * 3]!) + f(p[b * 3]!) + f(p[c * 3]!)) / 3, cz = (f(p[a * 3 + 2]!) + f(p[b * 3 + 2]!) + f(p[c * 3 + 2]!)) / 3;
      if (!inRect(area, cx, cz) || Math.floor(cx / CHUNK_SIZE) !== ix || Math.floor(cz / CHUNK_SIZE) !== iz) continue;
      for (const v of [a, b, c]) {
        let i = remap.get(v);
        if (i === undefined) {
          i = pos.length / 3;
          remap.set(v, i);
          pos.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!);
          uv.push(out.uv[v * 2]!, out.uv[v * 2 + 1]!);
          if (m.mark) mark.push(markValue);
        }
        idx.push(i);
      }
    }
  }
  if (idx.length === 0) return undefined;
  const mesh: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uv: Float32Array.from(uv) };
  if (m.mark) mesh.mark = Float32Array.from(mark);
  return mesh;
}
