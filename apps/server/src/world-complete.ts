import type { WorldIndex } from '@nn/shared';

/** The files listed in the world index that are not in `present` (names relative to the world directory). */
export function missingWorldFiles(index: WorldIndex, present: ReadonlySet<string>): string[] {
  return Object.keys(index.files).filter((name) => !present.has(name));
}

/**
 * The files whose content hash (`actual`: name → hash of the file on disk) differs from the index, or that the index
 * does not list: index.json is stale.
 */
export function staleWorldFiles(index: WorldIndex, actual: Readonly<Record<string, string>>): string[] {
  return Object.entries(actual)
    .filter(([name, hash]) => !Object.hasOwn(index.files, name) || index.files[name]!.hash !== hash)
    .map(([name]) => name);
}

/** What to run when index.json is missing: the built client's dist/world gets it from public/world by `npm run build`. */
export function missingIndexHint(worldDir: string): string {
  return /(^|[\\/])dist[\\/]world[\\/]?$/.test(worldDir)
    ? "'npm run build' ausführen (kopiert die Welt samt index.json aus apps/client/public/world; fehlt sie dort, vorher 'npm run world:index')"
    : "'npm run world:index' ausführen";
}
