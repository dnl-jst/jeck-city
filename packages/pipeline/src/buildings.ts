import { utmToLocal } from '@nn/shared';
import type { CityBuilding } from './citygml.js';
import { heightAt, type Heights } from './terrain/height.js';
import { triangulatePolygon3d } from './triangulate.js';

export type BuildingMesh = {
  id: string;
  centroid: { x: number; z: number };
  /** Unindexed triangles, local coordinates (x east, y up, z south). */
  positions: Float32Array;
  /** Flat per-triangle normals, one per vertex. */
  normals: Float32Array;
  /** Walls: (metres along wall, height above the LoD2 base, negative on plinths). Roofs: world (x, z). */
  facadeUv: Float32Array;
  /** Per vertex: 0 wall, 1 roof (ground/closure are dropped). */
  kind: Uint8Array;
  /** Local y of the LoD2 base (lowest ground point minus terrain datum); 0 without terrain. */
  base: number;
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

type Pt = { x: number; z: number };

function inRing(r: Pt[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!, b = r[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export type Footprint = { outer: Pt[]; holes: Pt[][] }[];

/** Point in union of ground polygons (holes respected). */
function insideFootprint(fp: Footprint, x: number, z: number): boolean {
  return fp.some((g) => inRing(g.outer, x, z) && !g.holes.some((h) => inRing(h, x, z)));
}

/** Highest roof y above (x, z); roofTris are local x,y,z triples. undefined if no roof covers the point. */
function roofHeightAt(roofTris: ArrayLike<number>, x: number, z: number): number | undefined {
  let best: number | undefined;
  for (let i = 0; i + 8 < roofTris.length; i += 9) {
    const ax = roofTris[i]!, ay = roofTris[i + 1]!, az = roofTris[i + 2]!;
    const bx = roofTris[i + 3]!, by = roofTris[i + 4]!, bz = roofTris[i + 5]!;
    const cx = roofTris[i + 6]!, cy = roofTris[i + 7]!, cz = roofTris[i + 8]!;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const y = l1 * ay + l2 * by + l3 * cy;
    if (best === undefined || y > best) best = y;
  }
  return best;
}

const FOOTPRINT_PROBE = 0.3;
const ROOF_PROBE = 0.05;
const HIDDEN_TOLERANCE = 0.1;

/**
 * A wall inside the building (party wall between parts, part seam): at the wall centre and near
 * each wall vertex, probes 0.3 m to both sides lie in the building's own footprint, and on both
 * sides the roof reaches the wall's top edge there, so no part of the wall can be seen (a taller
 * part's wall rising above a lower part's roof stays). `ring` is the wall polygon in local x,y,z,
 * `normal` its horizontal unit normal.
 */
export function isInternalWall(footprint: Footprint, roofTris: ArrayLike<number>, ring: readonly (readonly [number, number, number])[], normal: Pt): boolean {
  const cx = ring.reduce((m, p) => m + p[0], 0) / ring.length;
  const cz = ring.reduce((m, p) => m + p[2], 0) / ring.length;
  const dx = -normal.z, dz = normal.x; // along the wall
  const along = ring.map((p) => (p[0] - cx) * dx + (p[2] - cz) * dz);
  /** Highest point of the wall polygon above wall position s. */
  const topAt = (s: number): number => {
    let top = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const [si, sj] = [along[i]!, along[j]!];
      if ((si - s) * (sj - s) > 0) continue;
      const y = Math.abs(sj - si) < 1e-9 ? Math.max(ring[i]![1], ring[j]![1]) : ring[i]![1] + ((s - si) / (sj - si)) * (ring[j]![1] - ring[i]![1]);
      top = Math.max(top, y);
    }
    return top;
  };
  for (const s of [0, ...along.map((v) => v * 0.95)]) {
    const px = cx + dx * s, pz = cz + dz * s;
    const top = topAt(s);
    for (const side of [1, -1]) {
      if (!insideFootprint(footprint, px + normal.x * FOOTPRINT_PROBE * side, pz + normal.z * FOOTPRINT_PROBE * side)) return false;
      const roof = roofHeightAt(roofTris, px + normal.x * ROOF_PROBE * side, pz + normal.z * ROOF_PROBE * side);
      if (roof === undefined || roof < top - HIDDEN_TOLERANCE) return false;
    }
  }
  return true;
}

/** A plinth is added when the terrain under the walls drops this far below the base (m)… */
const PLINTH_TRIGGER = 0.3;
/** …and reaches this far below the lowest terrain point (m). */
const PLINTH_DEPTH = 0.3;
/** Wall edge counts as a bottom edge when both ends are at most this far above the wall's lowest point (m)… */
const BOTTOM_TOLERANCE = 0.05;
/** …and at most this far above the building's base (walls on a lower part's roof get no plinth) (m). */
const PLINTH_MAX_START = 0.3;
/** Spacing of the terrain samples along each plinth edge (m). */
const PLINTH_SAMPLE_STEP = 1;

/**
 * Without `ground`, y is height above the building's lowest ground point (y = z − minZ). With `ground`,
 * y is absolute local height (z − datum); facade v stays z − minZ, and where the terrain under the walls
 * comes within 0.3 m of the base or drops below it, every wall bottom edge at the base (within 0.3 m)
 * gets a plinth quad down to 0.3 m below the lowest terrain point (sampled every 1 m along those edges
 * and at the ground-surface corners).
 */
export function buildBuildingMesh(b: CityBuilding, ground?: { datum: number; terrain: Heights }): BuildingMesh | null {
  const groundSurfaces = b.surfaces.filter((s) => s.kind === 'ground');
  const groundPts = groundSurfaces.flatMap((s) => s.outer);
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

  const footprint: Footprint = groundSurfaces.map((g) => ({
    outer: g.outer.map(([e, n]) => utmToLocal(e, n)),
    holes: g.holes.map((h) => h.map(([e, n]) => utmToLocal(e, n))),
  }));

  const surfaces = b.surfaces.flatMap((s) => {
    if (s.kind !== 'wall' && s.kind !== 'roof') return [];
    const t = triangulatePolygon3d(s.outer, s.holes);
    if (!t) return [];
    const local: number[] = [];
    for (let i = 0; i < t.positions.length; i += 3) {
      const { x, z } = utmToLocal(t.positions[i]!, t.positions[i + 1]!);
      local.push(x, t.positions[i + 2]! - minZ, z);
    }
    return [{ s, t, local }];
  });
  // all roof triangles of the building (local x,y,z), for the internal-wall test
  const roofTris: number[] = [];
  for (const { s, t, local } of surfaces) {
    if (s.kind !== 'roof') continue;
    for (const k of t.indices) roofTris.push(local[k * 3]!, local[k * 3 + 1]!, local[k * 3 + 2]!);
  }

  // Internal-wall and roof tests above work in the relative frame (y = z − minZ); emitted y is shifted by `base`.
  const base = ground ? minZ - ground.datum : 0;
  type Edge = { a: readonly [number, number, number]; b: readonly [number, number, number]; ua: number; ub: number; n: readonly [number, number, number] };
  const bottomEdges: Edge[] = [];

  const pos: number[] = [], nor: number[] = [], uv: number[] = [], kind: number[] = [];
  for (const { s, t, local } of surfaces) {
    const isWall = s.kind === 'wall';
    // Wall u origin: first point of the wall's outer ring.
    const { x: x0, z: z0 } = utmToLocal(s.outer[0]![0], s.outer[0]![1]);

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
    // Target normal per SURFACE (never per triangle). Walls: the Newell normal, flipped when a
    // probe 0.3 m along it from the surface centre lies inside this building's footprint (no
    // footprint: centroid test). Roofs: the Newell normal, flipped to point up.
    const ring = s.outer.map(([e, n, z]) => {
      const l = utmToLocal(e, n);
      return [l.x, z - minZ, l.z] as const;
    });
    let nnx = 0, nny = 0, nnz = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
      nnx += (p[1] - q[1]) * (p[2] + q[2]);
      nny += (p[2] - q[2]) * (p[0] + q[0]);
      nnz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const nl = Math.hypot(nnx, nny, nnz);
    if (!(nl > 1e-9)) continue;
    let tx = nnx / nl, ty = nny / nl, tz = nnz / nl;
    const mcx = ring.reduce((m, p) => m + p[0], 0) / ring.length;
    const mcz = ring.reduce((m, p) => m + p[2], 0) / ring.length;
    const hl = Math.hypot(tx, tz);
    let flipSurface: boolean;
    if (!isWall && Math.abs(ty) > 1e-6) flipSurface = ty < 0;
    else if (hl < 1e-6) flipSurface = false;
    else if (footprint.length > 0) flipSurface = insideFootprint(footprint, mcx + (tx / hl) * 0.3, mcz + (tz / hl) * 0.3);
    else flipSurface = tx * (mcx - cx) + tz * (mcz - cz) < 0;
    if (flipSurface) { tx = -tx; ty = -ty; tz = -tz; }
    if (isWall && hl >= 1e-6 && footprint.length > 0 && isInternalWall(footprint, roofTris, ring, { x: tx / hl, z: tz / hl })) continue;
    const bottomMax = Math.min(Math.min(...ring.map((p) => p[1])) + BOTTOM_TOLERANCE, PLINTH_MAX_START);
    for (let k = 0; k < t.indices.length; k += 3) {
      let [a, bb, c] = tri(k);
      let n = normalOf(a, bb, c);
      if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue; // sliver
      if (n[0] * tx + n[1] * ty + n[2] * tz < 0) {
        [bb, c] = [c, bb];
        n = [-n[0], -n[1], -n[2]];
      }
      const corners = [a, bb, c];
      for (const i of corners) {
        pos.push(local[i]!, local[i + 1]! + base, local[i + 2]!);
        nor.push(n[0], n[1], n[2]);
        if (isWall) uv.push(Math.hypot(local[i]! - x0, local[i + 2]! - z0), local[i + 1]!);
        else uv.push(local[i]!, local[i + 2]!);
        kind.push(isWall ? 0 : 1);
      }
      if (!ground || !isWall) continue;
      for (let e = 0; e < 3; e++) {
        const i = corners[e]!, j = corners[(e + 1) % 3]!;
        if (local[i + 1]! > bottomMax || local[j + 1]! > bottomMax) continue;
        bottomEdges.push({
          a: [local[i]!, local[i + 1]! + base, local[i + 2]!],
          b: [local[j]!, local[j + 1]! + base, local[j + 2]!],
          ua: Math.hypot(local[i]! - x0, local[i + 2]! - z0),
          ub: Math.hypot(local[j]! - x0, local[j + 2]! - z0),
          n,
        });
      }
    }
  }
  if (pos.length === 0) return null;

  if (ground && bottomEdges.length > 0) {
    let gmin = Infinity;
    for (const { a, b: e } of bottomEdges) {
      const steps = Math.max(1, Math.ceil(Math.hypot(e[0] - a[0], e[2] - a[2]) / PLINTH_SAMPLE_STEP));
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        gmin = Math.min(gmin, heightAt(ground.terrain, a[0] + (e[0] - a[0]) * f, a[2] + (e[2] - a[2]) * f));
      }
    }
    for (const g of footprint) for (const p of g.outer) gmin = Math.min(gmin, heightAt(ground.terrain, p.x, p.z));
    if (gmin < base + PLINTH_TRIGGER) {
      const bottom = gmin - PLINTH_DEPTH;
      for (const { a, b: e, ua, ub, n } of bottomEdges) {
        // Below edge a→b of a wall triangle: walking b→a keeps the wall's winding on the other side of the edge.
        const quad: [readonly [number, number, number], number][] = [
          [e, ub], [a, ua], [[a[0], bottom, a[2]], ua],
          [e, ub], [[a[0], bottom, a[2]], ua], [[e[0], bottom, e[2]], ub],
        ];
        for (const [p, u] of quad) {
          pos.push(p[0], p[1], p[2]);
          nor.push(n[0], n[1], n[2]);
          uv.push(u, p[1] - base);
          kind.push(0);
        }
      }
    }
  }

  return {
    id: b.id,
    centroid: { x: cx, z: cz },
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    facadeUv: new Float32Array(uv),
    kind: new Uint8Array(kind),
    base,
    buildingSeed: fnv1a(b.id),
    flags: b.street === 'Neusser Str.' ? FLAG_NEUSSER : 0,
  };
}
