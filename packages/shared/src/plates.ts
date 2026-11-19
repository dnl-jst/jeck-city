/** Registration districts on the cars' plates: Köln first, then the districts around it. */
export const PLATE_DISTRICTS = ['K', 'BN', 'SU', 'BM', 'GL', 'LEV', 'NE', 'D'] as const;

/** Share of the cars registered in Köln. */
const HOME_SHARE = 0.8;

/** A well-mixed 32-bit hash of a car index. */
function hash(i: number): number {
  let h = (i + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The number plate of car `index` (its index in the manifest), the same on every client: a district, then only a
 * number. The number always starts with 0, which no real German plate does, so it can never be somebody's plate;
 * its other four digits are different for every car (up to 10 000 cars).
 */
export function plateText(index: number): string {
  const h = hash(index);
  const district = h / 2 ** 32 < HOME_SHARE ? PLATE_DISTRICTS[0] : PLATE_DISTRICTS[1 + ((h >>> 8) % (PLATE_DISTRICTS.length - 1))]!;
  // 7919 and 10 000 are coprime: a permutation of 0000…9999
  const n = (((index % 10000) + 10000) % 10000 * 7919 + 4217) % 10000;
  return `${district} 0${String(n).padStart(4, '0')}`;
}
