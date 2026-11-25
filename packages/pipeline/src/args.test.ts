import { expect, it } from 'vitest';
import { parsePipelineArgs, PIPELINE_USAGE } from './args';

const DEFAULT = 'apps/client/public/world';

it('parsePipelineArgs: no arguments → the default folder, a full run', () => {
  expect(parsePipelineArgs([], DEFAULT)).toEqual({ outDir: DEFAULT, transitOnly: false, listShops: false });
});

it('parsePipelineArgs reads --out <dir>, --transit-only and --list-shops in any order', () => {
  expect(parsePipelineArgs(['--out', 'data/reference/run-x', '--transit-only'], DEFAULT)).toEqual({ outDir: 'data/reference/run-x', transitOnly: true, listShops: false });
  expect(parsePipelineArgs(['--list-shops', '--out', 'w'], DEFAULT)).toEqual({ outDir: 'w', transitOnly: false, listShops: true });
});

it('parsePipelineArgs rejects unknown arguments, --out=dir, a missing or repeated --out folder, with the usage line', () => {
  for (const args of [['--outdir', 'x'], ['--out=x'], ['--transit'], ['stray'], ['--out'], ['--out', '--transit-only'], ['--out', 'a', '--out', 'b']]) {
    expect(() => parsePipelineArgs(args, DEFAULT), args.join(' ')).toThrow(PIPELINE_USAGE);
  }
  expect(() => parsePipelineArgs(['--out=x'], DEFAULT)).toThrow(/--out=x/);
});
