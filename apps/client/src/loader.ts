import { type Mesh, type Material, type Object3D, type Scene } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CHUNK_SIZE, parseManifest, type WorldManifest } from '@nn/shared';
import { FetchError } from './errors';
import { addEaveAttribute, createFacadeMaterial } from './materials/facade';
import { createStreetMaterials, STREET_RENDER_ORDER } from './materials/street';

export const LOAD_RADIUS = 600;
export const UNLOAD_RADIUS = 800;
export const MAX_CONCURRENT = 2;

type XZ = { x: number; z: number };

const centreDistance = (c: WorldManifest['chunks'][number], p: XZ): number =>
  Math.hypot(c.x + CHUNK_SIZE / 2 - p.x, c.z + CHUNK_SIZE / 2 - p.z);

/** Keys of chunks whose centre is ≤ LOAD_RADIUS from `pos` and not in `loaded`, nearest first. */
export function chunksToLoad(manifest: WorldManifest, pos: XZ, loaded: ReadonlySet<string>): string[] {
  return manifest.chunks
    .filter((c) => !loaded.has(c.key))
    .map((c) => ({ key: c.key, d: centreDistance(c, pos) }))
    .filter((c) => c.d <= LOAD_RADIUS)
    .sort((a, b) => a.d - b.d)
    .map((c) => c.key);
}

/** Keys in `loaded` whose chunk centre is > UNLOAD_RADIUS from `pos`. */
export function chunksToUnload(manifest: WorldManifest, pos: XZ, loaded: ReadonlySet<string>): string[] {
  return manifest.chunks.filter((c) => loaded.has(c.key) && centreDistance(c, pos) > UNLOAD_RADIUS).map((c) => c.key);
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new FetchError(url, res.status);
  return res;
}

/** Streams world chunks around the player into `scene`. */
export class WorldLoader {
  private manifest: WorldManifest | null = null;
  private readonly gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly loaded = new Map<string, Object3D>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private queue: string[] = [];
  private lastPos: XZ = { x: 0, z: 0 };
  readonly facade = createFacadeMaterial();
  readonly street = createStreetMaterials();

  constructor(private readonly scene: Scene, private readonly baseUrl: string) {}

  /** Loads the manifest and every chunk within LOAD_RADIUS of the spawn; resolves when they are in the scene. */
  async init(onProgress: (p: number) => void): Promise<WorldManifest> {
    const manifest = parseManifest(await (await fetchOk(`${this.baseUrl}manifest.json`)).json());
    this.manifest = manifest;
    const keys = chunksToLoad(manifest, manifest.spawn, new Set(this.loaded.keys()));
    let done = 0;
    onProgress(0);
    this.lastPos = manifest.spawn;
    // MAX_CONCURRENT workers drain the initial list; errors abort init
    const list = [...keys];
    const worker = async (): Promise<void> => {
      for (let key = list.shift(); key !== undefined; key = list.shift()) {
        await this.load(key);
        onProgress(++done / keys.length);
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
    return manifest;
  }

  /** Unloads far chunks and starts downloads of near ones (at most MAX_CONCURRENT in flight). */
  update(cameraPos: { x: number; z: number }): void {
    const m = this.manifest;
    if (!m) return;
    this.lastPos = { x: cameraPos.x, z: cameraPos.z };
    for (const key of chunksToUnload(m, cameraPos, new Set(this.loaded.keys()))) this.unload(key);
    const busy = new Set([...this.loaded.keys(), ...this.pending, ...this.failed]);
    this.queue = chunksToLoad(m, cameraPos, busy);
    while (this.pending.size < MAX_CONCURRENT && this.queue.length > 0) {
      const key = this.queue.shift()!;
      this.load(key).catch((err: unknown) => {
        this.failed.add(key);
        console.error(err);
      });
    }
  }

  private async load(key: string): Promise<void> {
    const chunk = this.manifest!.chunks.find((c) => c.key === key);
    if (!chunk) throw new Error(`unknown chunk ${key}`);
    this.pending.add(key);
    try {
      const buf = await (await fetchOk(`${this.baseUrl}${chunk.file}`)).arrayBuffer();
      const gltf = await this.gltf.parseAsync(buf, this.baseUrl);
      const root = gltf.scene;
      // the player may have moved away while this chunk was downloading
      if (centreDistance(chunk, this.lastPos) > UNLOAD_RADIUS) {
        disposeTree(root);
        return;
      }
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.name === 'buildings' ? this.facade : this.street[mesh.name];
        if (!mat) return;
        (mesh.material as Material).dispose();
        mesh.material = mat;
        if (mesh.name === 'buildings') addEaveAttribute(mesh.geometry);
        else mesh.renderOrder = STREET_RENDER_ORDER[mesh.name] ?? 0;
      });
      root.matrixAutoUpdate = false;
      root.updateMatrixWorld(true);
      this.scene.add(root);
      this.loaded.set(key, root);
    } finally {
      this.pending.delete(key);
    }
  }

  private unload(key: string): void {
    const root = this.loaded.get(key);
    if (!root) return;
    this.scene.remove(root);
    disposeTree(root);
    this.loaded.delete(key);
  }
}

/** Frees geometries only; materials are shared across chunks. */
function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}
