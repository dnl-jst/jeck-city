import type { WorldIndex } from '@nn/shared';

/** The files listed in the world index that are not in `present` (names relative to the world directory). */
export function missingWorldFiles(index: WorldIndex, present: ReadonlySet<string>): string[] {
  return Object.keys(index.files).filter((name) => !present.has(name));
}
