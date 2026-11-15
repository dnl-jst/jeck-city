import { Document, NodeIO } from '@gltf-transform/core';
import { expect, test } from 'vitest';
import { buildCollision } from './chunks.js';
import { prepareModel, prepareProp } from './models.js';

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

test('lift moves render and collision', async () => {
  const src = await glb([{ name: 'church', tx: 3, tz: 4 }, { name: 'church_col', tx: 3, tz: 4 }]);
  const renderMinY = async (bin: Uint8Array) => {
    const { MeshoptDecoder } = await import('meshoptimizer');
    const { EXTMeshoptCompression } = await import('@gltf-transform/extensions');
    await MeshoptDecoder.ready;
    const doc = await new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).readBinary(bin);
    let min = Infinity;
    for (const n of doc.getRoot().listNodes()) {
      const m = n.getWorldMatrix();
      for (const prim of n.getMesh()?.listPrimitives() ?? []) {
        const pos = prim.getAttribute('POSITION')!;
        const p = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, p);
          min = Math.min(min, m[1] * p[0]! + m[5] * p[1]! + m[9] * p[2]! + m[13]);
        }
      }
    }
    return min;
  };
  const colMinY = (c: Float32Array) => Math.min(...Array.from({ length: c.length / 3 }, (_, i) => c[i * 3 + 1]!));
  const flat = await prepareModel(src);
  const lifted = await prepareModel(src, 2.5);
  expect((await renderMinY(lifted.glb)) - (await renderMinY(flat.glb))).toBeCloseTo(2.5, 4);
  expect(colMinY(lifted.collision) - colMinY(flat.collision)).toBeCloseTo(2.5, 5);
  expect(lifted.centre).toEqual(flat.centre);
});

test('prepareProp keeps node names, hierarchy and empties, and compresses', async () => {
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene();
  const tri = (name: string) => doc.createMesh(name).addPrimitive(doc.createPrimitive().setAttribute('POSITION',
    doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf)));
  const frame = doc.createNode('frame').setMesh(tri('frame'));
  const fork = doc.createNode('fork').setTranslation([0, 1, -0.4]).setMesh(tri('fork'));
  const seat = doc.createNode('seat').setTranslation([0, 1, 0.3]);
  frame.addChild(fork).addChild(seat);
  scene.addChild(frame);
  const out = await prepareProp(await new NodeIO().writeBinary(doc));
  const { MeshoptDecoder } = await import('meshoptimizer');
  const { EXTMeshoptCompression } = await import('@gltf-transform/extensions');
  await MeshoptDecoder.ready;
  const back = await new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).readBinary(out);
  const f = back.getRoot().listNodes().find((n) => n.getName() === 'frame')!;
  expect(f.listChildren().map((n) => n.getName()).sort()).toEqual(['fork', 'seat']);
  expect(f.listChildren().find((n) => n.getName() === 'seat')!.getTranslation()).toEqual([0, 1, 0.3]);
  expect(back.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression');
});
