/** The pipeline's command line (`npm run pipeline -- …`). */
export const PIPELINE_USAGE = 'usage: npm run pipeline -- [--out <dir>] [--transit-only] [--list-shops]';

export type PipelineArgs = { outDir: string; transitOnly: boolean; listShops: boolean };

/** Thrown for a command line the pipeline does not understand (main exits with code 2). */
export class UsageError extends Error {}

/**
 * The pipeline's arguments: `--out <dir>` (the world folder to write and, with `--transit-only`, to read; default
 * `defaultOut`), `--transit-only`, `--list-shops`. Anything else is refused: a typo must not start a full build into
 * the default folder.
 */
export function parsePipelineArgs(args: string[], defaultOut: string): PipelineArgs {
  const bad = (why: string) => new UsageError(`pipeline: ${why}\n${PIPELINE_USAGE}`);
  const out: PipelineArgs = { outDir: defaultOut, transitOnly: false, listShops: false };
  let outSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--transit-only') out.transitOnly = true;
    else if (a === '--list-shops') out.listShops = true;
    else if (a === '--out') {
      const dir = args[++i];
      if (!dir || dir.startsWith('--')) throw bad('--out needs a folder');
      if (outSeen) throw bad('--out given twice');
      outSeen = true;
      out.outDir = dir;
    } else throw bad(`unknown argument ${a}`);
  }
  return out;
}
