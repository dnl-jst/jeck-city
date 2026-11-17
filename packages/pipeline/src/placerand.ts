import type { Pt } from './osm.js';

/** Positions are rounded to this grid (m) before hashing: centimetre noise in the input does not change a draw. */
const GRID = 0.5;

/**
 * Deterministic [0, 1) value of seed, a position and a salt (murmur3 finalizer). Placement decisions keyed by where
 * something stands, not by how many candidates came before it: an OSM change somewhere else leaves the cars, bikes
 * and scooters of untouched streets where they were. Use a different salt for each independent decision at a spot.
 */
export function placeRand(seed: number, p: Pt, salt = 0): number {
  const gx = Math.round(p.x / GRID), gz = Math.round(p.z / GRID);
  let h = (seed ^ Math.imul(gx, 0x9e3779b1) ^ Math.imul(gz, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
