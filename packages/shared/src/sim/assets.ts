import { decodeCollision, type CollisionAsset } from '../assets/collision';
import { parseManifest, type WorldManifest } from '../assets/manifest';
import { decodeTerrain, type TerrainGrid } from '../assets/terrain';

/** Web Crypto and TextDecoder exist in Node 24 and every browser; declared here because the shared lib is ES-only. */
declare const crypto: { subtle: { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> } };
declare const TextDecoder: new () => { decode(input: ArrayBuffer): string };

/** The three files both server and client build the simulated world from. */
export type WorldAssets = { manifest: WorldManifest; collision: CollisionAsset; terrain: TerrainGrid };

/** Reads manifest.json, collision.bin and terrain.bin through `read` (fetch in the browser, fs on the server). */
export async function loadWorldAssets(read: (file: string) => Promise<ArrayBuffer>): Promise<WorldAssets> {
  const [m, c, t] = await Promise.all([read('manifest.json'), read('collision.bin'), read('terrain.bin')]);
  return { manifest: parseManifest(JSON.parse(new TextDecoder().decode(m))), collision: decodeCollision(c), terrain: decodeTerrain(t) };
}

/** First 12 hex digits of the SHA-256 of manifest.json: client and server must have built the same world. */
export async function worldHash(manifestBytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', manifestBytes));
  let hex = '';
  for (const b of d.subarray(0, 6)) hex += b.toString(16).padStart(2, '0');
  return hex;
}
