import { NodeIO, type Document, type Node } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMaterialsEmissiveStrength, KHRTextureTransform } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/** Nodes whose name ends in this suffix are collision-only: they go to collision.bin, not into the rendered model. */
export const COLLISION_SUFFIX = '_col';

export type PreparedModel = {
  /** The model without collision nodes, EXT_meshopt_compression. */
  glb: Uint8Array;
  /** Collision triangles in world space, 9 floats per triangle. */
  collision: Float32Array;
  /** Bounding-box centre (x, z) of the rendered geometry, world space. */
  centre: { x: number; z: number };
};

const io = async () => {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  return new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMaterialsEmissiveStrength, KHRTextureTransform])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
};

/** World-space triangles (9 floats each) of every primitive of `node`'s mesh. */
function worldTriangles(node: Node): number[] {
  const out: number[] = [];
  const m = node.getWorldMatrix();
  for (const prim of node.getMesh()?.listPrimitives() ?? []) {
    if (prim.getMode() !== 4) continue; // TRIANGLES only
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const count = pos.getCount();
    const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: count }, (_, i) => i);
    const p = [0, 0, 0];
    for (let k = 0; k < idx.length; k++) {
      pos.getElement(idx[k]!, p);
      const [x, y, z] = p as [number, number, number];
      out.push(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      );
    }
  }
  return out;
}

function meshNodes(doc: Document): Node[] {
  return doc.getRoot().listNodes().filter((n) => n.getMesh());
}

/** Removes a node, its mesh and the mesh's accessors (each mesh is used by exactly one node in our exports). */
function disposeWithMesh(node: Node): void {
  const mesh = node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      for (const a of [...prim.listAttributes(), prim.getIndices()]) if (a && a.listParents().length <= 2) a.dispose();
      prim.dispose();
    }
    mesh.dispose();
  }
  node.dispose();
}

/**
 * Reads a building replacement model (glTF binary in world space, Y up, metres, see data/models/README.md),
 * splits off its `*_col` nodes as collision (all meshes if there are none) and re-encodes it.
 * `lift` raises the whole model (scene root nodes and collision) by that many metres in y.
 */
export async function prepareModel(glb: Uint8Array, lift = 0): Promise<PreparedModel> {
  const nio = await io();
  const doc = await nio.readBinary(glb);
  if (lift !== 0) {
    for (const scene of doc.getRoot().listScenes()) {
      for (const root of scene.listChildren()) {
        const [x, y, z] = root.getTranslation();
        root.setTranslation([x, y + lift, z]);
      }
    }
  }
  const nodes = meshNodes(doc);
  const col = nodes.filter((n) => n.getName().endsWith(COLLISION_SUFFIX));
  const visual = nodes.filter((n) => !col.includes(n));
  if (visual.length === 0) throw new Error('model has no rendered meshes');
  const collision = Float32Array.from((col.length ? col : visual).flatMap(worldTriangles));
  for (const n of col) disposeWithMesh(n);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of visual) {
    const t = worldTriangles(n);
    for (let i = 0; i < t.length; i += 3) {
      minX = Math.min(minX, t[i]!); maxX = Math.max(maxX, t[i]!);
      minZ = Math.min(minZ, t[i + 2]!); maxZ = Math.max(maxZ, t[i + 2]!);
    }
  }
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return { glb: await nio.writeBinary(doc), collision, centre: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 } };
}

/**
 * Re-encodes a prop model (bikes, racks; data/models/bikes/README.md) with meshopt, keeping its nodes, their names,
 * transforms and empties as they are: the client animates the parts by node name.
 */
export async function prepareProp(glb: Uint8Array): Promise<Uint8Array> {
  const nio = await io();
  const doc = await nio.readBinary(glb);
  if (meshNodes(doc).length === 0) throw new Error('prop model has no meshes');
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return nio.writeBinary(doc);
}
