/**
 * Static collision geometry for the whole world (Rapier trimesh on client and server).
 * vertices: x,y,z triples in local world coordinates; indices: triangle list; boundary: x,z pairs of the play area.
 */
export type CollisionAsset = { vertices: Float32Array; indices: Uint32Array; boundary: Float32Array };

const MAGIC = 'NNC2';
const HEADER = 16; // magic + three uint32 element counts

/**
 * Layout: 'NNC2', uint32 vertices.length, indices.length, boundary.length (element counts), then little-endian:
 * vertices as int32 centimetres, each stored as the difference to the same axis of the previous vertex (so they
 * gzip well); indices as int32 differences to the previous index; boundary as float32.
 * Vertices are quantised to 1 cm.
 */
export function encodeCollision(a: CollisionAsset): ArrayBuffer {
  const total = HEADER + 4 * (a.vertices.length + a.indices.length + a.boundary.length);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, a.vertices.length, true);
  view.setUint32(8, a.indices.length, true);
  view.setUint32(12, a.boundary.length, true);
  let o = HEADER;
  const prev = [0, 0, 0];
  a.vertices.forEach((v, i) => {
    // (stored as differences: one value that is not a number would shift every vertex after it)
    if (!Number.isFinite(v)) throw new Error('collision: non-finite vertex');
    const cm = Math.round(v * 100);
    view.setInt32(o, cm - prev[i % 3]!, true);
    prev[i % 3] = cm;
    o += 4;
  });
  let p = 0;
  for (const v of a.indices) { view.setInt32(o, v - p, true); p = v; o += 4; }
  for (const v of a.boundary) { view.setFloat32(o, v, true); o += 4; }
  return buf;
}

/** `a` with the triangles of `b` added (b's boundary is ignored): e.g. the city plus the underground Stadtbahn's own file. */
export function mergeCollision(a: CollisionAsset, b: CollisionAsset): CollisionAsset {
  const vertices = new Float32Array(a.vertices.length + b.vertices.length), indices = new Uint32Array(a.indices.length + b.indices.length);
  vertices.set(a.vertices);
  vertices.set(b.vertices, a.vertices.length);
  indices.set(a.indices);
  const base = a.vertices.length / 3;
  for (let i = 0; i < b.indices.length; i++) indices[a.indices.length + i] = b.indices[i]! + base;
  return { vertices, indices, boundary: a.boundary };
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
  const prev = [0, 0, 0];
  for (let i = 0; i < nv; i++, o += 4) {
    prev[i % 3]! += view.getInt32(o, true);
    vertices[i] = prev[i % 3]! / 100;
  }
  const indices = new Uint32Array(ni);
  let p = 0;
  for (let i = 0; i < ni; i++, o += 4) { p += view.getInt32(o, true); indices[i] = p; }
  const boundary = new Float32Array(nb);
  for (let i = 0; i < nb; i++, o += 4) boundary[i] = view.getFloat32(o, true);
  for (const i of indices) if (i >= nv / 3) throw new Error('collision: index out of range');
  return { vertices, indices, boundary };
}
