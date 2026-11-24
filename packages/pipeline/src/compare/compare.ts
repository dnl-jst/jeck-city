import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { decodeTerrain, parseWorldIndex, WORLD_INDEX_FILE, worldHash, type WorldIndex } from '@nn/shared';
import { buildWorldIndex } from '../worldindex.js';

export type FileDiff = { name: string; kind: 'missing-a' | 'missing-b' | 'different'; detail?: string };

/**
 * Compares two world folders file by file: both sides are hashed from disk (buildWorldIndex), so neither a stale
 * index.json nor a file it does not list can hide a difference. A stored index.json that is missing or does not match
 * its folder is a difference of its own. `worldHashA/B` are the hashes of the stored index.json files (the hash the
 * game uses; 'none' without one); `detail` explains a difference where it can.
 */
export async function compareWorlds(a: string, b: string): Promise<{ same: boolean; worldHashA: string; worldHashB: string; diffs: FileDiff[] }> {
  const [sa, sb] = await Promise.all([readSide(a), readSide(b)]);
  const names = [...new Set([...Object.keys(sa.disk.files), ...Object.keys(sb.disk.files)])].sort();
  const diffs: FileDiff[] = [];
  for (const [side, s, missing] of [['A', sa, 'missing-a'], ['B', sb, 'missing-b']] as const) {
    if (!s.stored) diffs.push({ name: WORLD_INDEX_FILE, kind: missing, detail: `no ${WORLD_INDEX_FILE} on side ${side} (aborted run?)` });
    else if (!sameIndex(s.stored, s.disk)) {
      diffs.push({ name: WORLD_INDEX_FILE, kind: 'different', detail: `stored ${WORLD_INDEX_FILE} does not match the files on disk (side ${side})` });
    }
  }
  for (const name of names) {
    const fa = sa.disk.files[name], fb = sb.disk.files[name];
    if (!fa) diffs.push({ name, kind: 'missing-a' });
    else if (!fb) diffs.push({ name, kind: 'missing-b' });
    else if (fa.hash !== fb.hash) {
      const detail = await explain(name, join(a, name), join(b, name));
      diffs.push(detail === undefined ? { name, kind: 'different' } : { name, kind: 'different', detail });
    }
  }
  return { same: diffs.length === 0 && sa.hash === sb.hash, worldHashA: sa.hash, worldHashB: sb.hash, diffs };
}

/** The index hashed from disk, and the stored index.json with its world hash (null / 'none' when there is none). */
async function readSide(dir: string): Promise<{ disk: WorldIndex; stored: WorldIndex | null; hash: string }> {
  const disk = await buildWorldIndex(dir);
  const path = join(dir, WORLD_INDEX_FILE);
  if (!existsSync(path)) return { disk, stored: null, hash: 'none' };
  const bytes = await readFile(path);
  return { disk, stored: parseWorldIndex(JSON.parse(bytes.toString('utf8'))), hash: await worldHash(toArrayBuffer(bytes)) };
}

function sameIndex(x: WorldIndex, y: WorldIndex): boolean {
  const kx = Object.keys(x.files), ky = Object.keys(y.files);
  return kx.length === ky.length && kx.every((k) => y.files[k]?.hash === x.files[k]!.hash && y.files[k]?.bytes === x.files[k]!.bytes);
}

/** What differs inside a file, for the kinds of file that can say more than "different". */
async function explain(name: string, pa: string, pb: string): Promise<string | undefined> {
  try {
    if (name === 'terrain.bin') return explainTerrain(await readFile(pa), await readFile(pb));
    if (name === 'manifest.json') return explainManifest(await readFile(pa, 'utf8'), await readFile(pb, 'utf8'));
    if (name.endsWith('.glb')) return await explainGlb(await readFile(pa), await readFile(pb));
  } catch (err) {
    return `(could not compare the contents: ${err instanceof Error ? err.message : String(err)})`;
  }
  return undefined;
}

/** "<n> heights differ, max <d> cm" (heights are stored in whole centimetres), plus header differences. */
function explainTerrain(a: Buffer, b: Buffer): string {
  const ta = decodeTerrain(toArrayBuffer(a)), tb = decodeTerrain(toArrayBuffer(b));
  if (ta.cols !== tb.cols || ta.rows !== tb.rows) return `grid ${ta.cols}×${ta.rows} vs ${tb.cols}×${tb.rows}`;
  const parts: string[] = [];
  for (const k of ['x0', 'z0', 'datum'] as const) if (ta[k] !== tb[k]) parts.push(`${k} ${ta[k]} vs ${tb[k]}`);
  let n = 0, maxCm = 0;
  for (let i = 0; i < ta.heights.length; i++) {
    const cm = Math.round(Math.abs(ta.heights[i]! - tb.heights[i]!) * 100);
    if (cm > 0) {
      n++;
      maxCm = Math.max(maxCm, cm);
    }
  }
  if (n > 0 || parts.length === 0) parts.unshift(`${n} heights differ, max ${maxCm} cm`);
  return parts.join('; ');
}

/** The top-level keys whose values differ. */
function explainManifest(a: string, b: string): string {
  const ma = JSON.parse(a) as Record<string, unknown>, mb = JSON.parse(b) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ma), ...Object.keys(mb)])];
  const differ = keys.filter((k) => JSON.stringify(ma[k]) !== JSON.stringify(mb[k]));
  return differ.length ? `top-level keys differ: ${differ.join(', ')}` : 'same values, different bytes (key order or formatting)';
}

let gltfIo: NodeIO | undefined;
async function io(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  gltfIo ??= new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return gltfIo;
}

/** Triangles and vertices per mesh name (summed over a name's meshes and primitives). */
async function meshCounts(glb: Buffer): Promise<Map<string, { tris: number; verts: number }>> {
  const doc = await (await io()).readBinary(new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength));
  const counts = new Map<string, { tris: number; verts: number }>();
  for (const mesh of doc.getRoot().listMeshes()) {
    const c = counts.get(mesh.getName()) ?? { tris: 0, verts: 0 };
    for (const prim of mesh.listPrimitives()) {
      const verts = prim.getAttribute('POSITION')?.getCount() ?? 0;
      c.verts += verts;
      if (prim.getMode() === 4) c.tris += (prim.getIndices()?.getCount() ?? verts) / 3; // TRIANGLES only
    }
    counts.set(mesh.getName(), c);
  }
  return counts;
}

/** Per mesh name whose counts differ: "<name>: A <t> tris/<v> verts, B <t> tris/<v> verts". */
async function explainGlb(a: Buffer, b: Buffer): Promise<string> {
  const [ca, cb] = await Promise.all([meshCounts(a), meshCounts(b)]);
  const fmt = (c: { tris: number; verts: number } | undefined) => (c ? `${c.tris} tris/${c.verts} verts` : 'none');
  const names = [...new Set([...ca.keys(), ...cb.keys()])].sort();
  const differ = names.filter((n) => ca.get(n)?.tris !== cb.get(n)?.tris || ca.get(n)?.verts !== cb.get(n)?.verts);
  if (!differ.length) return `same counts per mesh (${names.map((n) => `${n || '(unnamed)'}: ${fmt(ca.get(n))}`).join('; ')}), contents differ`;
  return differ.map((n) => `${n || '(unnamed)'}: A ${fmt(ca.get(n))}, B ${fmt(cb.get(n))}`).join('; ');
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
