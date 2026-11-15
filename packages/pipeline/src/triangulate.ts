import earcut from 'earcut';
import type { Ring } from './citygml.js';

export type Triangulated = { positions: number[]; indices: number[] };

/** Newell normal of a ring (unnormalised; length = 2 * area). */
function newell(r: Ring): [number, number, number] {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!, b = r[(i + 1) % r.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/**
 * Triangulates a planar 3D polygon (with holes) by projecting onto the plane of its
 * Newell normal and running earcut. Returns null for degenerate polygons.
 */
export function triangulatePolygon3d(outer: Ring, holes: Ring[]): Triangulated | null {
  if (outer.length < 3) return null;
  const n = newell(outer);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 1e-9)) return null;
  const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
  // Orthonormal basis (u, v) of the plane; (u, v, normal) is right-handed so
  // the 2D winding matches the 3D winding seen from the normal side.
  const ref: [number, number, number] = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ny * ref[2] - nz * ref[1], uy = nz * ref[0] - nx * ref[2], uz = nx * ref[1] - ny * ref[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;

  const positions: number[] = [];
  const flat: number[] = [];
  const holeStarts: number[] = [];
  const push = (r: Ring) => {
    for (const [x, y, z] of r) {
      positions.push(x, y, z);
      flat.push(x * ux + y * uy + z * uz, x * vx + y * vy + z * vz);
    }
  };
  push(outer);
  for (const h of holes) {
    if (h.length < 3) continue;
    holeStarts.push(positions.length / 3);
    push(h);
  }
  const indices = earcut(flat, holeStarts, 2);
  if (indices.length < 3) return null;
  return { positions, indices };
}
