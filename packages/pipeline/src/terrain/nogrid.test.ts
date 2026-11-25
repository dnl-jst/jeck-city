import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Stage 4's promise: no pipeline code allocates an array with one entry per grid cell (cols × rows). The terrain is
// read through windows and point lookups of the version files (terrain/file.ts), the water lives in sparse rasters.
// This scans every non-test source file under packages/pipeline/src for the ways such an array used to be made.
//
// Windows: TerrainFile.window()/windowAt() allocate w × h cells of a window, never cols × rows of the grid; they are
// bounded by TerrainFile's maxWindowCells (a window of the whole grid throws), so they need no exception here.

const ROOT = join(import.meta.dirname, '..');

/** (file, rule) pairs that may match, each with its reason. Paths relative to packages/pipeline/src. */
const EXCEPTIONS: { file: string; rule: Rule; reason: string }[] = [
  { file: 'compare/compare.ts', rule: 'decodeTerrain', reason: 'the world:compare tool, not the pipeline run: it decodes two terrain.bin files whole to explain a difference' },
  { file: 'compare/compare.ts', rule: 'heights.length', reason: 'the world:compare tool (see above): loops over the two decoded grids' },
  { file: 'terrain/file.ts', rule: 'decodeTerrain', reason: 'implements the terrain.bin format the decoder reads (byte-identical by construction)' },
  { file: 'terrain/testgrid.ts', rule: 'grid-sized typed array', reason: 'test fixture: builds small random grids for the terrain tests; imported by tests only (checked below)' },
  { file: 'riverfixture.ts', rule: 'grid-sized typed array', reason: 'test fixture: the 401 × 301 river terrain of the water tests; imported by tests only (checked below)' },
];
/** Exceptions that are test fixtures: no production source may import them. */
const FIXTURES = ['terrain/testgrid.ts', 'riverfixture.ts'];

type Rule = 'grid-sized typed array' | 'grid-sized size variable' | 'decodeTerrain' | 'heights.length';

const isTest = (name: string) => name.endsWith('.test.ts') || name.endsWith('.test-util.ts');

/** Non-test .ts files under the pipeline sources (test files and *.test-util.ts hold dense reference copies). */
function sources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !isTest(e.name)) out.push({ file: relative(ROOT, p).split('\\').join('/'), src: readFileSync(p, 'utf8') });
    }
  };
  walk(ROOT);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The source without block and line comments (a comment may name what it no longer does). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');

const TYPED = '(?:Float32|Float64|Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|BigInt64|BigUint64)Array';
/** cols × rows (or width × height) in either order, on any object: `t.cols * t.rows`, `cols*rows`, `m.width * m.height`. */
const GRID_PRODUCT = /\b(?:cols|width)\s*\*\s*(?:[\w$]+\s*\.\s*)*(?:rows|height)\b|\b(?:rows|height)\s*\*\s*(?:[\w$]+\s*\.\s*)*(?:cols|width)\b/;

/** The rules a source breaks, with the offending text. */
function violations(src: string): { rule: Rule; text: string }[] {
  const c = code(src);
  const out: { rule: Rule; text: string }[] = [];
  // new Float32Array(t.cols * t.rows …), new Array(cols * rows), Array.from({ length: cols * rows }), TypedArray.from({ length: … })
  for (const m of c.matchAll(new RegExp(`new\\s+(?:${TYPED}|Array)\\s*\\(([^;]*)`, 'g')))
    if (GRID_PRODUCT.test(firstArgument(m[1]!))) out.push({ rule: 'grid-sized typed array', text: m[0].slice(0, 80) });
  for (const m of c.matchAll(/length\s*:\s*([^,}]*)/g)) if (GRID_PRODUCT.test(m[1]!)) out.push({ rule: 'grid-sized typed array', text: m[0].slice(0, 80) });
  // const n = t.cols * t.rows; … new Uint8Array(n)
  for (const m of c.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*([^;,\n]*)/g)) {
    if (!GRID_PRODUCT.test(m[2]!)) continue;
    const use = new RegExp(`new\\s+(?:${TYPED}|Array)\\s*\\(\\s*${m[1]!.replace(/\$/g, '\\$')}\\b|length\\s*:\\s*${m[1]!.replace(/\$/g, '\\$')}\\b`);
    if (use.test(c)) out.push({ rule: 'grid-sized size variable', text: m[0].slice(0, 80) });
  }
  for (const m of c.matchAll(/\bdecodeTerrain\s*\(/g)) out.push({ rule: 'decodeTerrain', text: m[0] });
  for (const m of c.matchAll(/\.\s*heights\s*\.\s*length\b/g)) out.push({ rule: 'heights.length', text: m[0] });
  return out;
}

/** The text of the first argument of a call whose argument list starts at `rest` (balanced parentheses). */
function firstArgument(rest: string): string {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return rest.slice(0, i);
      depth--;
    } else if (ch === ',' && depth === 0) return rest.slice(0, i);
  }
  return rest;
}

describe('no full-size terrain arrays', () => {
  it('the scanner catches the forms a grid-sized array was made in', () => {
    const rules = (s: string) => violations(s).map((v) => v.rule);
    expect(rules('const h = new Float32Array(t.cols * t.rows);')).toEqual(['grid-sized typed array']);
    expect(rules('const h = new Float32Array(cols * rows).fill(NaN);')).toEqual(['grid-sized typed array']);
    expect(rules('const d = new Float32Array(width * height);')).toEqual(['grid-sized typed array']);
    expect(rules('const d = new Uint8Array(t.rows * t.cols);')).toEqual(['grid-sized typed array']);
    expect(rules('const n = t.cols * t.rows;\nconst mask = new Uint8Array(n);')).toEqual(['grid-sized size variable']);
    expect(rules('const n = grid.cols * grid.rows;\nconst a = Array.from({ length: n }, () => 0);')).toEqual(['grid-sized size variable']);
    expect(rules('const a = Float32Array.from({ length: cols * rows }, f);')).toEqual(['grid-sized typed array']);
    expect(rules('const g = decodeTerrain(buf);')).toEqual(['decodeTerrain']);
    expect(rules('for (let i = 0; i < t.heights.length; i++) {}')).toEqual(['heights.length']);
    // not grid-sized: a row, a window, a page, comments
    expect(rules('const row = new Float32Array(t.cols);')).toEqual([]);
    expect(rules('const out = new Float32Array(w * h);')).toEqual([]);
    expect(rules('const p = new Float32Array(PAGE * PAGE);')).toEqual([]);
    expect(rules('const s = new Float32Array(g.cols), n = g.cols * 2;')).toEqual([]);
    expect(rules('// was: new Float32Array(cols * rows) and decodeTerrain(…)\n/* t.heights.length */')).toEqual([]);
    expect(rules('const expected = HEADER + 2 * cols * rows;')).toEqual([]);
  });

  it('no pipeline source allocates a cols × rows array', () => {
    const found: string[] = [];
    for (const { file, src } of sources())
      for (const v of violations(src)) if (!EXCEPTIONS.some((e) => e.file === file && e.rule === v.rule)) found.push(`${file}: ${v.rule}: ${v.text}`);
    expect(found).toEqual([]);
  });

  it('every exception names a reason, and the fixtures among them are imported by tests only', () => {
    for (const e of EXCEPTIONS) expect(e.reason.length, `${e.file} ${e.rule}`).toBeGreaterThan(20);
    const importers: string[] = [];
    for (const { file, src } of sources())
      for (const fx of FIXTURES) {
        const stem = fx.replace(/\.ts$/, '').split('/').pop()!;
        if (file !== fx && new RegExp(`from\\s*['"][^'"]*\\b${stem}(?:\\.js)?['"]|import\\s*\\(\\s*['"][^'"]*\\b${stem}(?:\\.js)?['"]`).test(code(src))) importers.push(`${file} imports ${fx}`);
      }
    expect(importers).toEqual([]);
  });
});
