/**
 * Track bed for the chunk `tram` mesh (rail ribbons, uv.v 0 → rail width across, no normals).
 * Each rail ribbon is widened into a band from BED_OUT outside the rail to just past the track
 * centre, so the two bands of a track join into one ~1.7 m bed (grooved rails set in the street,
 * as in Köln). The centre side is found by probing for the partner rail one gauge away; a rail
 * without a partner gets a symmetric band. Output uv: (u along, metres across from the rail
 * centre, positive towards the track centre).
 */
export const GAUGE = 1.435;
export const BED_Y = 0.016;
const BED_OUT = 0.12;
const BED_IN = 0.74; // rail centre → just past the track centre (gauge / 2 = 0.7175)
const BED_SOLO = 0.4;

export function trackBed(positions: ArrayLike<number>, uv: ArrayLike<number>, index: ArrayLike<number>): { positions: Float32Array; uv: Float32Array; index: ArrayLike<number> } {
  const n = positions.length / 3;
  let railW = 0;
  for (let i = 0; i < n; i++) railW = Math.max(railW, uv[i * 2 + 1]!);
  const half = railW / 2;
  const px = (i: number) => positions[i * 3]!, pz = (i: number) => positions[i * 3 + 2]!;
  const high = (i: number) => uv[i * 2 + 1]! > half;

  // across direction per vertex (xz, pointing from the v = 0 edge to the v = railW edge)
  const acc = new Float64Array(n * 2);
  for (let t = 0; t + 2 < index.length; t += 3) {
    const tri = [index[t]!, index[t + 1]!, index[t + 2]!];
    const hi = tri.filter(high), lo = tri.filter((i) => !high(i));
    const pair = hi.length === 2 ? hi : lo.length === 2 ? lo : null;
    if (!pair) continue;
    const ax = px(pair[1]!) - px(pair[0]!), az = pz(pair[1]!) - pz(pair[0]!);
    const l = Math.hypot(ax, az);
    if (l < 1e-6) continue;
    let dx = -az / l, dz = ax / l;
    const odd = (hi.length === 2 ? lo : hi)[0]!;
    const sign = (high(odd) ? 1 : -1) * ((px(odd) - px(pair[0]!)) * dx + (pz(odd) - pz(pair[0]!)) * dz);
    if (sign < 0) { dx = -dx; dz = -dz; }
    for (const i of tri) { acc[i * 2]! += dx; acc[i * 2 + 1]! += dz; }
  }

  // spatial hash of all rail vertices for the partner probe
  const cell = 0.5, grid = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / cell)}_${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    const k = key(px(i), pz(i));
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  const near = (x: number, z: number, r: number): boolean => {
    for (let gx = -1; gx <= 1; gx++)
      for (let gz = -1; gz <= 1; gz++)
        for (const i of grid.get(key(x + gx * cell, z + gz * cell)) ?? []) if (Math.hypot(px(i) - x, pz(i) - z) <= r) return true;
    return false;
  };

  const outPos = new Float32Array(n * 3), outUv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let dx = acc[i * 2]!, dz = acc[i * 2 + 1]!;
    const l = Math.hypot(dx, dz);
    if (l > 1e-9) { dx /= l; dz /= l; }
    const off = half - uv[i * 2 + 1]!;
    const mx = px(i) + dx * off, mz = pz(i) + dz * off; // rail centre line
    const tol = half + 0.08;
    const centre = near(mx + dx * GAUGE, mz + dz * GAUGE, tol) ? 1 : near(mx - dx * GAUGE, mz - dz * GAUGE, tol) ? -1 : 0;
    const side = high(i) ? 1 : -1;
    const a = centre === 0 ? side * BED_SOLO : side === centre ? BED_IN : -BED_OUT; // across, + towards centre
    const d = centre === 0 ? a : a * centre; // along the direction vector
    outPos[i * 3] = mx + dx * d;
    outPos[i * 3 + 1] = BED_Y;
    outPos[i * 3 + 2] = mz + dz * d;
    outUv[i * 2] = uv[i * 2]!;
    outUv[i * 2 + 1] = a;
  }
  return { positions: outPos, uv: outUv, index };
}
