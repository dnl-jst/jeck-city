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
];

type Rule = 'grid-sized typed array' | 'grid-sized size variable' | 'decodeTerrain' | 'heights.length';

const isTest = (name: string) => name.endsWith('.test.ts') || name.endsWith('.test-util.ts');

/**
 * Non-test .ts files under the pipeline sources. Test files and *.test-util.ts (dense reference copies, test grids)
 * are left out; that production never imports a *.test-util.ts is checked below.
 */
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

/**
 * The source without block and line comments (a comment may name what it no longer does). String and template
 * literals are kept as they are (a glob like '**' + '/*.ts' is no comment); a backslash escapes the next character
 * everywhere, so the slashes of a regex literal such as /\/\// start no comment either.
 */
function code(src: string): string {
  let out = '', i = 0;
  while (i < src.length) {
    const ch = src[i]!, next = src[i + 1];
    if (ch === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && !(ch !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The parts of `text` between top-level commas (parentheses, brackets and braces balanced). */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

const TYPED = '(?:Float32|Float64|Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|BigInt64|BigUint64)Array';
/** cols × rows (or width × height) in either order, on any object: `t.cols * t.rows`, `cols*rows`, `m.width * m.height`. */
const GRID_PRODUCT = /\b(?:cols|width)\s*\*\s*(?:[\w$]+\s*\.\s*)*(?:rows|height)\b|\b(?:rows|height)\s*\*\s*(?:[\w$]+\s*\.\s*)*(?:cols|width)\b/;

/** The rules a source breaks, with the offending text. */
function violations(src: string): { rule: Rule; text: string }[] {
  const c = code(src);
  const out: { rule: Rule; text: string }[] = [];
  // new Float32Array(t.cols * t.rows …), new Array(cols * rows), Array(cols * rows), Array.from({ length: cols * rows }), TypedArray.from({ length: … })
  for (const m of c.matchAll(new RegExp(`(?:\\bnew\\s+)?(?<![\\w$.])(?:${TYPED}|Array)\\s*\\(([^;]*)`, 'g')))
    if (GRID_PRODUCT.test(firstArgument(m[1]!))) out.push({ rule: 'grid-sized typed array', text: m[0].slice(0, 80) });
  for (const m of c.matchAll(/length\s*:\s*([^,}]*)/g)) if (GRID_PRODUCT.test(m[1]!)) out.push({ rule: 'grid-sized typed array', text: m[0].slice(0, 80) });
  // const n = t.cols * t.rows; … new Uint8Array(n) – every declarator of a declaration (const a = 1, n = cols * rows)
  for (const m of c.matchAll(/\b(?:const|let|var)\s+([^;]*)/g))
    for (const part of topLevelParts(m[1]!)) {
      const d = /^\s*([\w$]+)\s*(?::[^=]*)?=([\s\S]*)$/.exec(part);
      if (!d || !GRID_PRODUCT.test(d[2]!)) continue;
      const name = d[1]!.replace(/\$/g, '\\$');
      const use = new RegExp(`(?<![\\w$.])(?:${TYPED}|Array)\\s*\\(\\s*${name}\\b|length\\s*:\\s*${name}\\b`);
      if (use.test(c)) out.push({ rule: 'grid-sized size variable', text: part.trim().slice(0, 80) });
    }
  for (const m of c.matchAll(/\bdecodeTerrain\s*\(/g)) out.push({ rule: 'decodeTerrain', text: m[0] });
  // t.heights.length, and heights.length after `const { heights } = t`
  for (const m of c.matchAll(/\bheights\s*\.\s*length\b/g)) out.push({ rule: 'heights.length', text: m[0] });
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
    expect(rules('const { heights } = t;\nfor (let i = 0; i < heights.length; i++) {}')).toEqual(['heights.length']);
    expect(rules('const a = Array(cols * rows).fill(0);')).toEqual(['grid-sized typed array']);
    expect(rules('const a = 1, n = t.cols * t.rows;\nconst m = new Uint8Array(n);')).toEqual(['grid-sized size variable']);
    expect(rules('const a = f(x, y), n: number = grid.rows * grid.cols, b = 2;\nconst m = new Float64Array(n);')).toEqual(['grid-sized size variable']);
    // a string holding a block-comment opener hides nothing after it
    expect(rules("const glob = 'src/**/*.ts';\nconst h = new Float32Array(cols * rows);")).toEqual(['grid-sized typed array']);
    expect(rules('const re = /\\/\\//g;\nconst h = decodeTerrain(b);')).toEqual(['decodeTerrain']);
    // not grid-sized: a row, a window, a page, comments
    expect(rules('const row = new Float32Array(t.cols);')).toEqual([]);
    expect(rules('const out = new Float32Array(w * h);')).toEqual([]);
    expect(rules('const p = new Float32Array(PAGE * PAGE);')).toEqual([]);
    expect(rules('const s = new Float32Array(g.cols), n = g.cols * 2;')).toEqual([]);
    expect(rules('// was: new Float32Array(cols * rows) and decodeTerrain(…)\n/* t.heights.length */')).toEqual([]);
    expect(rules('const expected = HEADER + 2 * cols * rows;')).toEqual([]);
    expect(rules('const ok = Array.isArray(x), n = cols * rows;')).toEqual([]);
    expect(rules('const t = new Float32Array(MAX + 1);')).toEqual([]);
  });

  it('no pipeline source allocates a cols × rows array', () => {
    const found: string[] = [];
    for (const { file, src } of sources())
      for (const v of violations(src)) if (!EXCEPTIONS.some((e) => e.file === file && e.rule === v.rule)) found.push(`${file}: ${v.rule}: ${v.text}`);
    expect(found).toEqual([]);
  });

  it('every exception names a reason, and no production source imports a *.test-util.ts', () => {
    for (const e of EXCEPTIONS) expect(e.reason.length, `${e.file} ${e.rule}`).toBeGreaterThan(20);
    // (*.test-util.ts files are outside the scan and outside the building cache's code hash: production must not use them)
    const importers: string[] = [];
    for (const { file, src } of sources()) for (const spec of testUtilSpecifiers(src)) importers.push(`${file} imports ${spec}`);
    expect(importers).toEqual([]);
  });

  it('the import check catches every form of reaching a *.test-util.ts', () => {
    expect(testUtilSpecifiers("import { mosaic } from './dgm.dense.test-util.js';")).toEqual(['./dgm.dense.test-util.js']);
    expect(testUtilSpecifiers('import type { X } from "../a.test-util";')).toEqual(['../a.test-util']);
    expect(testUtilSpecifiers("import './side.test-util.js';")).toEqual(['./side.test-util.js']);
    expect(testUtilSpecifiers("export { rng } from './testgrid.test-util.js';\nexport * from './b.test-util.js';")).toEqual(['./testgrid.test-util.js', './b.test-util.js']);
    expect(testUtilSpecifiers("const m = await import( './c.test-util.js' );")).toEqual(['./c.test-util.js']);
    expect(testUtilSpecifiers("// import { x } from './c.test-util.js'\nimport { y } from './util.js';")).toEqual([]);
  });
});

/** The module specifiers containing `.test-util` that a source imports, re-exports or loads dynamically. */
function testUtilSpecifiers(src: string): string[] {
  const c = code(src);
  const out: string[] = [];
  const re = /\bfrom\s*(['"])([^'"]*)\1|\bimport\s*(['"])([^'"]*)\3|\bimport\s*\(\s*(['"`])([^'"`]*)\5\s*\)/g;
  for (const m of c.matchAll(re)) {
    const spec = m[2] ?? m[4] ?? m[6]!;
    if (spec.includes('.test-util')) out.push(spec);
  }
  return out;
}
