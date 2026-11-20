import { decodeCollision, mergeCollision, type CollisionAsset } from '../assets/collision';
import { parseManifest, type WorldManifest } from '../assets/manifest';
import { decodeTerrain, type TerrainGrid } from '../assets/terrain';

/** TextDecoder exists in Node 24 and every browser; declared here because the shared lib is ES-only. */
declare const TextDecoder: new () => { decode(input: ArrayBuffer): string };

/** The three files both server and client build the simulated world from. */
export type WorldAssets = { manifest: WorldManifest; collision: CollisionAsset; terrain: TerrainGrid };

/** Reads manifest.json, collision.bin and terrain.bin through `read` (fetch in the browser, fs on the server). */
export async function loadWorldAssets(read: (file: string) => Promise<ArrayBuffer>): Promise<WorldAssets> {
  const [m, c, t] = await Promise.all([read('manifest.json'), read('collision.bin'), read('terrain.bin')]);
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(m)));
  return { manifest, collision: await withTransitCollision(manifest, decodeCollision(c), read), terrain: decodeTerrain(t) };
}

/** The city's collision with the Stadtbahn's own file added (manifest.transitCollision), if the world has one. */
export async function withTransitCollision(manifest: WorldManifest, city: CollisionAsset, read: (file: string) => Promise<ArrayBuffer>): Promise<CollisionAsset> {
  return manifest.transitCollision ? mergeCollision(city, decodeCollision(await read(manifest.transitCollision.file))) : city;
}

/**
 * First 12 hex digits of the SHA-256 of manifest.json: client and server must have built the same world.
 * Plain JS instead of Web Crypto: crypto.subtle only exists in secure contexts, so a page opened over plain http on
 * the LAN (http://192.168.…) could not start.
 */
export async function worldHash(manifestBytes: ArrayBuffer): Promise<string> {
  const d = sha256(new Uint8Array(manifestBytes));
  let hex = '';
  for (const b of d.subarray(0, 6)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 (FIPS 180-4) of `msg`. */
function sha256(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const buf = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  buf.set(msg);
  buf[len] = 0x80;
  const v = new DataView(buf.buffer);
  v.setUint32(buf.length - 8, Math.floor(len / 0x20000000)); // message length in bits, high word
  v.setUint32(buf.length - 4, (len << 3) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64).fill(0);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = v.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + k) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(4 * i, x));
  return out;
}
