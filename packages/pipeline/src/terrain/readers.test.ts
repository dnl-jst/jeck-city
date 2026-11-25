import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, decodeTerrain, encodeTerrain, type TerrainGrid } from '@nn/shared';
import { drapeChunk, prepareFlat } from '../chunkdrape.js';
import { chunkGeometries, meshSource, type ChunkGeometry, type Rect } from '../chunks.js';
import { followDeviation, followTerrain } from '../follow.js';
import { chunkWindow, groundMesh } from '../ground.js';
import type { Mesh } from '../streets.js';
import { contentHash, fileContentHash } from '../worldindex.js';
import { TerrainFile, writeTerrainFile } from './file.js';
import { TerrainSampler } from './height.js';
import { randomGrid, rng } from './testgrid.js';

// Task 5: every reader of the final terrain works on a window of the file or on point queries; the results must be
// the same, byte for byte, as on the whole decoded grid.

let dir: string;
const open: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-readers-'));
});
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The grid as a terrain file, and the whole grid as decodeTerrain gives it (the reference). */
function fileOf(t: TerrainGrid, blocks?: number): { file: TerrainFile; ref: TerrainGrid } {
  const file = writeTerrainFile(join(dir, `t${open.length}.bin`), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols)));
  open.push(file);
  const f = blocks === undefined ? file : TerrainFile.open(file.path, { blocks });
  if (f !== file) open.push(f);
  return { file: f, ref: decodeTerrain(encodeTerrain(t)) };
}

const bytes = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');
const meshBytes = (m: (Mesh & { normals?: Float32Array }) | null | undefined) =>
  m && { positions: bytes(m.positions), uv: bytes(m.uv), indices: bytes(m.indices), mark: m.mark && bytes(m.mark), normals: m.normals && bytes(m.normals) };

/** Flat street triangles of all sizes, vertical kerb faces across chunk lines, one long face reaching out of chunk 0_0. */
function streetMesh(): Mesh {
  const rand = rng(21);
  const pos: number[] = [], idx: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    idx.push(pos.length / 3, pos.length / 3 + 1, pos.length / 3 + 2);
    pos.push(...a, ...b, ...c);
  };
  // flat triangles of all sizes, some reaching over chunk edges
  for (let k = 0; k < 120; k++) {
    const x = -350 + rand() * 900, z = -250 + rand() * 800, s = 1 + rand() * (k % 10 === 0 ? 120 : 15);
    tri([x, 0.02, z], [x + s * rand(), 0.02, z + s], [x + s, 0.02, z + s * rand()]);
  }
  // vertical kerb faces crossing chunk lines, and one 160 m long face in chunk 0_0 that reaches 60 m beyond it
  for (let k = 0; k < 12; k++) {
    const [ax, az, bx, bz] = [190 + k * 3.1, 180 + k * 19.7, 190 + (k + 1) * 3.1, 180 + (k + 1) * 19.7];
    tri([ax, 0, az], [bx, 0, bz], [bx, 0.12, bz]);
    tri([ax, 0, az], [bx, 0.12, bz], [ax, 0.12, az]);
  }
  tri([40, 0, 100.5], [200 + 60, 0, 100.5], [200 + 60, 0.12, 100.5]);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uv: Float32Array.from(pos.flatMap((_, i) => (i % 3 === 1 ? [] : [pos[i]! / 7]))) };
}

describe('chunk readers on a window', { timeout: 60000 }, () => {
  it('groundMesh on a chunk window (chunk + 2 cells) equals groundMesh on the whole grid, for an inner chunk, an edge chunk and a corner chunk', () => {
    // x, z ∈ [-250, 450] (+ fraction): chunks -2 … 2; (0, 0) inner, (2, 0) and (0, -2) at an edge, (-2, -2) and (2, 2) corners
    for (const [x0, z0] of [[-250, -250], [-250.3, -249.7]]) {
      const { file, ref } = fileOf(randomGrid(701, 701, 3, x0, z0));
      for (const [ix, iz] of [[0, 0], [1, -1], [2, 0], [0, -2], [-2, -2], [2, 2], [-2, 1]] as const) {
        const w = chunkWindow(file, ix, iz);
        expect(w.cols * w.rows, `${ix}_${iz}`).toBeLessThanOrEqual(206 * 206);
        expect(meshBytes(groundMesh(w, ix, iz)), `${ix}_${iz} at ${x0}`).toEqual(meshBytes(groundMesh(ref, ix, iz)));
      }
    }
  });

  it('drapeChunk with a chunk window + sampler fallback equals drapeChunk on the whole grid — including a vertical face that leaves the window', () => {
    // a fractional origin: the drape lattice must stay relative to the whole grid's origin
    const { file, ref } = fileOf(randomGrid(1000, 900, 8, -400.5, -300.25), 4);
    const area: Rect = { minX: -380, minZ: -280, maxX: 580, maxZ: 580 };
    const m = streetMesh();
    const src = prepareFlat(m, area);
    let pieces = 0;
    for (const key of src.trianglesByChunk.keys()) {
      const [ix, iz] = key.split('_').map(Number) as [number, number];
      const inGrid = (ix + 1) * CHUNK_SIZE > file.x0 && ix * CHUNK_SIZE < file.x0 + file.cols - 1 && (iz + 1) * CHUNK_SIZE > file.z0 && iz * CHUNK_SIZE < file.z0 + file.rows - 1;
      const heights = new TerrainSampler(file, inGrid ? chunkWindow(file, ix, iz) : undefined);
      const got = drapeChunk(src, heights, ix, iz, area), want = drapeChunk(src, ref, ix, iz, area);
      expect(meshBytes(got), key).toEqual(meshBytes(want));
      pieces += want?.indices.length ?? 0;
    }
    expect(pieces).toBeGreaterThan(1000);
    // the long face does leave the window of chunk 0_0
    const w = chunkWindow(file, 0, 0);
    expect(w.x0 + w.cols - 1).toBeLessThan(260);
  });

  it('chunkGeometries on the terrain file equals chunkGeometries on the whole grid (ground and draped streets)', async () => {
    const { file, ref } = fileOf(randomGrid(700, 650, 9, -250, -150), 2);
    // the area reaches beyond the grid: chunks there have no ground and drape through the sampler alone
    const area: Rect = { minX: -380, minZ: -280, maxX: 580, maxZ: 580 };
    const run = async (t: TerrainGrid | TerrainFile) => {
      const out: ChunkGeometry[] = [];
      const counts = {};
      for await (const c of chunkGeometries(meshSource([]), {}, {}, area, t, {}, { road: prepareFlat(streetMesh(), area) }, counts)) out.push(c);
      return { out, counts };
    };
    const got = await run(file), want = await run(ref);
    expect(got.out.map((c) => c.key)).toEqual(want.out.map((c) => c.key));
    expect(got.out.filter((c) => c.ground).length).toBeGreaterThan(9);
    for (const [i, c] of got.out.entries()) {
      const w = want.out[i]!;
      expect(meshBytes(c.ground), c.key).toEqual(meshBytes(w.ground));
      expect(meshBytes(c.streets.road), c.key).toEqual(meshBytes(w.streets.road));
    }
    expect(got.counts).toEqual(want.counts);
  });
});

describe('scattered readers on point queries', () => {
  it('followTerrain with a sampler equals followTerrain on the whole grid (frozen digests unchanged)', () => {
    // kerb strips across a 550 m stretch of street-like terrain (a slope with swells and bumps); one cached block, so
    // the lookups keep evicting
    const cols = 700, rows = 300, heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) heights[r * cols + c] = 0.03 * c + 0.5 * Math.sin(c / 10) * Math.cos(r / 12) + 0.1 * Math.sin(c) * Math.cos(r);
    const { file, ref } = fileOf({ x0: -100, z0: -60, cols, rows, datum: 0, heights }, 1);
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i < 30; i++) {
      const a = -0.6 + i / 25, len = 30 + (i % 7) * 9, w = 0.3 + (i % 3) * 1.4;
      const x0 = -80 + (i % 10) * 55, z0 = -40 + Math.floor(i / 10) * 70;
      const dx = Math.cos(a), dz = Math.sin(a), nx = -dz * w, nz = dx * w;
      const base = pos.length / 3;
      for (let k = 0; k <= 4; k++) {
        const x = x0 + (dx * len * k) / 4, z = z0 + (dz * len * k) / 4;
        pos.push(x, 0.12, z, x + nx, 0.12, z + nz);
        uv.push(k, 0, k, 1);
      }
      for (let k = 0; k < 4; k++) idx.push(base + 2 * k, base + 2 * k + 1, base + 2 * k + 2, base + 2 * k + 2, base + 2 * k + 1, base + 2 * k + 3);
    }
    const m: Mesh = { positions: Float32Array.from(pos), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
    const s = new TerrainSampler(file);
    for (const [maxEdge, tol, minEdge] of [[8, 0.02, 0.05], [3, Infinity, 0.5]] as const) {
      const got = followTerrain(m, s, maxEdge, tol, minEdge), want = followTerrain(m, ref, maxEdge, tol, minEdge);
      expect(meshBytes(got)).toEqual(meshBytes(want));
      expect(followDeviation(got, s)).toEqual(followDeviation(want, ref));
    }
  });

  it('fileContentHash of a terrain file is contentHash of its bytes (the transit env stamp)', () => {
    const { file } = fileOf(randomGrid(300, 200, 2), 1);
    expect(fileContentHash(file)).toBe(contentHash(readFileSync(file.path)));
  });

  it('the @nn/shared import scan catches every form that can bring heightAt in', () => {
    const scan = (src: string) => sharedHeightAtUses(src);
    expect(scan("import { heightAt } from '@nn/shared';")).toEqual(['named import']);
    expect(scan("import { CHUNK_SIZE, heightAt as h } from \"@nn/shared\";")).toEqual(['named import']);
    expect(scan("import type { TerrainGrid } from '@nn/shared';\nimport {\n  type X,\n  heightAt,\n} from '@nn/shared';")).toEqual(['named import']);
    expect(scan("import shared, { heightAt } from '@nn/shared';")).toEqual(['named import']);
    expect(scan("import * as shared from '@nn/shared';")).toEqual(['namespace import']);
    expect(scan("import shared, * as all from '@nn/shared';")).toEqual(['namespace import']);
    expect(scan("export { heightAt } from '@nn/shared';")).toEqual(['re-export']);
    expect(scan("export { heightAt as h } from \"@nn/shared\";")).toEqual(['re-export']);
    expect(scan("export * from '@nn/shared';")).toEqual(['re-export']);
    expect(scan("export * as s from '@nn/shared';")).toEqual(['re-export']);
    expect(scan("const s = await import('@nn/shared');")).toEqual(['dynamic import']);
    expect(scan("const s = await import( \"@nn/shared\" );")).toEqual(['dynamic import']);
    // not a use: other names, other packages, type-only imports of other names
    expect(scan("import { CHUNK_SIZE, heightAtOther, type TerrainGrid } from '@nn/shared';")).toEqual([]);
    expect(scan("import { heightAt } from './terrain/height.js';")).toEqual([]);
    expect(scan("import * as fs from 'node:fs';\nexport { heightAt } from './height.js';")).toEqual([]);
  });

  it('heightAt is imported from @nn/shared only in terrain/height.ts', () => {
    const root = join(import.meta.dirname, '..');
    /** Files that may bring in @nn/shared wholesale (a namespace import, a dynamic import, `export *`), with the reason. */
    const ALLOWED: Record<string, string> = {};
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          const file = p.slice(root.length + 1).split('\\').join('/');
          for (const use of sharedHeightAtUses(readFileSync(p, 'utf8')))
            if (!(use === 'named import' && file === 'terrain/height.ts') && !(use !== 'named import' && file in ALLOWED)) offenders.push(`${file}: ${use}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    // and height.ts does import it (the scan works on the real sources)
    expect(sharedHeightAtUses(readFileSync(join(root, 'terrain/height.ts'), 'utf8'))).toEqual(['named import']);
  });
});

const SHARED = String.raw`(?:'@nn\/shared'|"@nn\/shared")`;
/**
 * The ways a source can reach @nn/shared's heightAt: a named import or re-export of it (also renamed, next to a default
 * import, over several lines, either quote), and the forms that bring in the whole module (a namespace import,
 * `export *`, a dynamic import) – those count wherever they appear.
 */
function sharedHeightAtUses(src: string): string[] {
  const out: string[] = [];
  const names = (list: string) => list.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim());
  for (const m of src.matchAll(new RegExp(String.raw`\bimport\s+(type\s+)?([^'";]*?)\s*from\s*${SHARED}`, 'g'))) {
    const clause = m[2]!;
    if (/\*\s*as\s+[\w$]+/.test(clause)) out.push('namespace import');
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces && names(braces[1]!).includes('heightAt')) out.push('named import');
  }
  for (const m of src.matchAll(new RegExp(String.raw`\bexport\s+(type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*${SHARED}`, 'g'))) {
    const clause = m[2]!;
    if (clause.startsWith('*') || names(clause.slice(1, -1)).includes('heightAt')) out.push('re-export');
  }
  for (const _ of src.matchAll(new RegExp(String.raw`\bimport\s*\(\s*${SHARED}\s*\)`, 'g'))) out.push('dynamic import');
  return out;
}
