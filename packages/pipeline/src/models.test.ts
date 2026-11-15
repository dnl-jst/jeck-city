import { Document, NodeIO } from '@gltf-transform/core';
import { expect, test } from 'vitest';
import { buildCollision } from './chunks.js';
import { prepareModel } from './models.js';

/** GLB with a unit-triangle mesh `name` under a node translated by (tx, 0, tz). */
async function glb(meshes: { name: string; tx: number; tz: number }[]): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene();
  for (const m of meshes) {
    const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos);
    scene.addChild(doc.createNode(m.name).setTranslation([m.tx, 0, m.tz]).setMesh(doc.createMesh(m.name).addPrimitive(prim)));
  }
  return new NodeIO().writeBinary(doc);
}

test('prepareModel splits *_col nodes into world-space collision and drops them from the model', async () => {
  const m = await prepareModel(await glb([{ name: 'church', tx: 100, tz: 50 }, { name: 'church_col', tx: 10, tz: 20 }]));
  expect(Array.from(m.collision)).toEqual([10, 0, 20, 11, 0, 20, 10, 1, 20]);
  expect(m.centre).toEqual({ x: 100.5, z: 50 });
  const { MeshoptDecoder } = await import('meshoptimizer');
  const { EXTMeshoptCompression } = await import('@gltf-transform/extensions');
  await MeshoptDecoder.ready;
  const doc = await new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).readBinary(m.glb);
  expect(doc.getRoot().listNodes().map((n) => n.getName())).toEqual(['church']);
  expect(doc.getRoot().listMeshes()).toHaveLength(1);
});

test('prepareModel without *_col nodes collides with the rendered meshes', async () => {
  const m = await prepareModel(await glb([{ name: 'kiosk', tx: 0, tz: 0 }]));
  expect(m.collision.length).toBe(9);
});

test('buildCollision adds extra triangle soups', () => {
  const empty = { positions: new Float32Array(), indices: new Uint32Array(), uv: new Float32Array() };
  const boundary = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
  const base = buildCollision({ buildings: [], curb: empty, sidewalk: empty, boundary });
  const more = buildCollision({ buildings: [], curb: empty, sidewalk: empty, boundary, extra: [new Float32Array([0, 0, 0, 1, 5, 0, 0, 5, 1])] });
  expect(more.indices.length - base.indices.length).toBe(3);
});
