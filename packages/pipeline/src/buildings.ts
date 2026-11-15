import { utmToLocal } from '@nn/shared';
import type { CityBuilding } from './citygml.js';
import { triangulatePolygon3d } from './triangulate.js';

export type BuildingMesh = {
  id: string;
  centroid: { x: number; z: number };
  /** Unindexed triangles, local coordinates (x east, y up, z south). */
  positions: Float32Array;
  /** Flat per-triangle normals, one per vertex. */
  normals: Float32Array;
  /** Walls: (metres along wall, height above ground). Roofs: world (x, z). */
  facadeUv: Float32Array;
  /** Per vertex: 0 wall, 1 roof (ground/closure are dropped). */
  kind: Uint8Array;
  buildingSeed: number;
  /** Bit 0: address on Neusser Str. (shop row). Bit 1 (backdrop) is set in Task 7. */
  flags: number;
};

export const FLAG_NEUSSER = 1;

/** 32-bit FNV-1a over UTF-8 bytes. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(s, 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function buildBuildingMesh(b: CityBuilding): BuildingMesh | null {
  const ground = b.surfaces.filter((s) => s.kind === 'ground');
  const groundPts = ground.flatMap((s) => s.outer);
  const allPts = b.surfaces.flatMap((s) => s.outer);
  const refPts = groundPts.length > 0 ? groundPts : allPts;
  if (refPts.length === 0) return null;
  const minZ = Math.min(...refPts.map((p) => p[2]));

  let cx = 0, cz = 0;
  for (const [e, n] of refPts) {
    const l = utmToLocal(e, n);
    cx += l.x; cz += l.z;
  }
  cx /= refPts.length; cz /= refPts.length;

  const pos: number[] = [], nor: number[] = [], uv: number[] = [], kind: number[] = [];
  for (const s of b.surfaces) {
    if (s.kind !== 'wall' && s.kind !== 'roof') continue;
    const t = triangulatePolygon3d(s.outer, s.holes);
    if (!t) continue;
    const isWall = s.kind === 'wall';
    const local: number[] = [];
    for (let i = 0; i < t.positions.length; i += 3) {
      const { x, z } = utmToLocal(t.positions[i]!, t.positions[i + 1]!);
      local.push(x, t.positions[i + 2]! - minZ, z);
    }
    // Wall u origin: first point of the wall's outer ring.
    const { x: x0, z: z0 } = utmToLocal(s.outer[0]![0], s.outer[0]![1]);

    // Surface orientation from the first non-degenerate triangle (planar polygon).
    const tri = (k: number) => [t.indices[k]! * 3, t.indices[k + 1]! * 3, t.indices[k + 2]! * 3] as const;
    const normalOf = (a: number, bb: number, c: number): [number, number, number] => {
      const e1 = [local[bb]! - local[a]!, local[bb + 1]! - local[a + 1]!, local[bb + 2]! - local[a + 2]!];
      const e2 = [local[c]! - local[a]!, local[c + 1]! - local[a + 1]!, local[c + 2]! - local[a + 2]!];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      const l = Math.hypot(nx, ny, nz);
      return l > 1e-12 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
    };
    // Decide flip per triangle (brief: normal . (midpoint - centroid) > 0 for walls; y > 0 for roofs).
    for (let k = 0; k < t.indices.length; k += 3) {
      let [a, bb, c] = tri(k);
      let n = normalOf(a, bb, c);
      if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue; // sliver
      let flip: boolean;
      const mx = (local[a]! + local[bb]! + local[c]!) / 3 - cx;
      const mz = (local[a + 2]! + local[bb + 2]! + local[c + 2]!) / 3 - cz;
      if (!isWall && Math.abs(n[1]) > 1e-6) flip = n[1] < 0;
      else flip = n[0] * mx + n[2] * mz < 0;
      if (flip) {
        [bb, c] = [c, bb];
        n = [-n[0], -n[1], -n[2]];
      }
      for (const i of [a, bb, c]) {
        pos.push(local[i]!, local[i + 1]!, local[i + 2]!);
        nor.push(n[0], n[1], n[2]);
        if (isWall) uv.push(Math.hypot(local[i]! - x0, local[i + 2]! - z0), local[i + 1]!);
        else uv.push(local[i]!, local[i + 2]!);
        kind.push(isWall ? 0 : 1);
      }
    }
  }
  if (pos.length === 0) return null;

  return {
    id: b.id,
    centroid: { x: cx, z: cz },
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    facadeUv: new Float32Array(uv),
    kind: new Uint8Array(kind),
    buildingSeed: fnv1a(b.id),
    flags: b.street === 'Neusser Str.' ? FLAG_NEUSSER : 0,
  };
}
