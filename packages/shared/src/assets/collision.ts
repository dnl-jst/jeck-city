/**
 * Static collision geometry for the whole world (Rapier trimesh on client and server).
 * vertices: x,y,z triples in local world coordinates; indices: triangle list; boundary: x,z pairs of the play area.
 */
export type CollisionAsset = { vertices: Float32Array; indices: Uint32Array; boundary: Float32Array };

const MAGIC = 'NNC1';
const HEADER = 16; // magic + three uint32 element counts

/** Layout: 'NNC1', uint32 vertices.length, indices.length, boundary.length (element counts), then the arrays, all little-endian. */
export function encodeCollision(a: CollisionAsset): ArrayBuffer {
  const total = HEADER + 4 * (a.vertices.length + a.indices.length + a.boundary.length);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, a.vertices.length, true);
  view.setUint32(8, a.indices.length, true);
  view.setUint32(12, a.boundary.length, true);
  let o = HEADER;
  for (const v of a.vertices) { view.setFloat32(o, v, true); o += 4; }
  for (const v of a.indices) { view.setUint32(o, v, true); o += 4; }
  for (const v of a.boundary) { view.setFloat32(o, v, true); o += 4; }
  return buf;
}

export function decodeCollision(buf: ArrayBuffer): CollisionAsset {
  if (buf.byteLength < HEADER) throw new Error('collision: buffer too short');
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error(`collision: bad magic ${JSON.stringify(magic)}`);
  const nv = view.getUint32(4, true);
  const ni = view.getUint32(8, true);
  const nb = view.getUint32(12, true);
  if (buf.byteLength !== HEADER + 4 * (nv + ni + nb)) throw new Error('collision: length mismatch');
  let o = HEADER;
  const vertices = new Float32Array(nv);
  for (let i = 0; i < nv; i++, o += 4) vertices[i] = view.getFloat32(o, true);
  const indices = new Uint32Array(ni);
  for (let i = 0; i < ni; i++, o += 4) indices[i] = view.getUint32(o, true);
  const boundary = new Float32Array(nb);
  for (let i = 0; i < nb; i++, o += 4) boundary[i] = view.getFloat32(o, true);
  for (const i of indices) if (i >= nv / 3) throw new Error('collision: index out of range');
  return { vertices, indices, boundary };
}
