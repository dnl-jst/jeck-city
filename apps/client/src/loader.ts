import { BufferAttribute, BufferGeometry, Mesh, type Material, type Object3D, type Scene } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CHUNK_SIZE, parseManifest, type WorldManifest } from '@nn/shared';
import { FetchError } from './errors';
import { trackBed } from './trackbed';
import { addEaveAttribute, createFacadeMaterial, FLAG_SIGNED } from './materials/facade';
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
  /** update() is a no-op until init() has finished. */
  private ready = false;
  private readonly gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly loaded = new Map<string, Object3D>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private queue: string[] = [];
  /** Buildings that carry a real shop sign: their facade sign band gets no pseudo lettering. */
  private signed = new Set<string>();
  private lastPos: XZ = { x: 0, z: 0 };
  /** Incremented whenever a chunk is added to or removed from the scene. */
  revision = 0;
  readonly facade = createFacadeMaterial();
  readonly street = createStreetMaterials();

  constructor(private readonly scene: Scene, private readonly baseUrl: string) {}

  /**
   * Loads the manifest and every chunk within LOAD_RADIUS of `start` (default: the spawn);
   * resolves when they are in the scene.
   */
  async init(onProgress: (p: number) => void, start?: XZ): Promise<WorldManifest> {
    const manifest = parseManifest(await (await fetchOk(`${this.baseUrl}manifest.json`)).json());
    this.manifest = manifest;
    this.signed = new Set(manifest.shops.flatMap((s) => (s.sign && s.buildingId ? [s.buildingId] : [])));
    const from = start ?? manifest.spawn;
    this.lastPos = { x: from.x, z: from.z };
    const keys = chunksToLoad(manifest, from, new Set(this.loaded.keys()));
    let done = 0;
    onProgress(0);
    // MAX_CONCURRENT workers drain the initial list; errors abort init
    const list = [...keys];
    const worker = async (): Promise<void> => {
      for (let key = list.shift(); key !== undefined; key = list.shift()) {
        await this.load(key);
        onProgress(++done / keys.length);
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
    this.ready = true;
    return manifest;
  }

  /** Unloads far chunks and starts downloads of near ones (at most MAX_CONCURRENT in flight). */
  update(cameraPos: { x: number; z: number }): void {
    const m = this.manifest;
    if (!m || !this.ready) return;
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
      const tram = root.getObjectByName('tram') as Mesh | undefined;
      if (tram?.isMesh) root.add(this.trackBedMesh(tram));
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh || mesh.name === 'trackbed') return;
        const mat = mesh.name === 'buildings' ? this.facade : this.street[mesh.name];
        if (!mat) return;
        (mesh.material as Material).dispose();
        mesh.material = mat;
        mesh.receiveShadow = true;
        if (mesh.name === 'buildings') {
          addEaveAttribute(mesh.geometry);
          markSigned(mesh.geometry, root.userData.buildings, this.signed);
          mesh.castShadow = true;
        } else mesh.renderOrder = STREET_RENDER_ORDER[mesh.name] ?? 0;
      });
      root.matrixAutoUpdate = false;
      root.updateMatrixWorld(true);
      this.scene.add(root);
      this.loaded.set(key, root);
      this.revision++;
    } finally {
      this.pending.delete(key);
    }
  }

  private trackBedMesh(tram: Mesh): Mesh {
    const g = tram.geometry;
    const index = g.index?.array ?? Uint32Array.from({ length: g.getAttribute('position').count }, (_, i) => i);
    const bed = trackBed(g.getAttribute('position').array, g.getAttribute('uv').array, index);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(bed.positions, 3));
    geo.setAttribute('uv', new BufferAttribute(bed.uv, 2));
    geo.setIndex(Array.from(bed.index));
    const mesh = new Mesh(geo, this.street.trackbed);
    mesh.name = 'trackbed';
    mesh.receiveShadow = true;
    mesh.renderOrder = STREET_RENDER_ORDER.trackbed ?? 0;
    return mesh;
  }

  private unload(key: string): void {
    const root = this.loaded.get(key);
    if (!root) return;
    this.scene.remove(root);
    disposeTree(root);
    this.loaded.delete(key);
    this.revision++;
  }

  /** Keys of the chunks currently in the scene. */
  loadedKeys(): ReadonlySet<string> {
    return new Set(this.loaded.keys());
  }
}

/** Sets _flags bit 2 (FLAG_SIGNED) on the vertices of buildings that carry a shop sign board. */
export function markSigned(g: BufferGeometry, ranges: unknown, signed: ReadonlySet<string>): void {
  const flags = g.getAttribute('_flags') as BufferAttribute | undefined;
  if (!flags || !Array.isArray(ranges) || signed.size === 0) return;
  for (const r of ranges as { id: string; firstVertex: number; vertexCount: number }[]) {
    if (!signed.has(r.id)) continue;
    for (let i = r.firstVertex; i < r.firstVertex + r.vertexCount; i++) flags.setX(i, (flags.getX(i) & 3) | FLAG_SIGNED);
  }
  flags.needsUpdate = true;
}

/** Frees geometries only; materials are shared across chunks. */
function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}
