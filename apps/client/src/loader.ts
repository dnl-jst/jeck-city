import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, type Material, type Object3D, type Scene, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CHUNK_SIZE, parseManifest, type BikeType, type CarType, type WorldManifest } from '@nn/shared';
import { CharacterModels } from './characters';
import { FetchError } from './errors';
import { addEaveAttribute, createFacadeMaterial, FLAG_SIGNED } from './materials/facade';
import { createStreetMaterials, STREET_RENDER_ORDER } from './materials/street';

export const LOAD_RADIUS = 600;
/** Only chunks this close are awaited before the game is playable; the rest streams in afterwards. */
export const READY_RADIUS = 250;
export const UNLOAD_RADIUS = 800;
export const MAX_CONCURRENT = 2;

/** Wait before the 1st, 2nd and 3rd retry of a chunk whose download failed; after that it stays missing. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;

type XZ = { x: number; z: number };

/** When (ms, same clock as `lastAt`) a chunk may be tried again after its `failures`-th failure at `lastAt`; null = never. */
export function nextRetryAt(failures: number, lastAt: number): number | null {
  const d = RETRY_DELAYS_MS[failures - 1];
  return d === undefined ? null : lastAt + d;
}

const centreDistance = (c: WorldManifest['chunks'][number], p: XZ): number =>
  Math.hypot(c.x + CHUNK_SIZE / 2 - p.x, c.z + CHUNK_SIZE / 2 - p.z);

/** Keys of chunks whose centre is ≤ LOAD_RADIUS from `pos` and not in `loaded`, nearest first. */
export function chunksToLoad(manifest: WorldManifest, pos: XZ, loaded: ReadonlySet<string>, radius = LOAD_RADIUS): string[] {
  return manifest.chunks
    .filter((c) => !loaded.has(c.key))
    .map((c) => ({ key: c.key, d: centreDistance(c, pos) }))
    .filter((c) => c.d <= radius)
    .sort((a, b) => a.d - b.d)
    .map((c) => c.key);
}

/** Keys in `loaded` whose chunk centre is > UNLOAD_RADIUS from `pos`. */
export function chunksToUnload(manifest: WorldManifest, pos: XZ, loaded: ReadonlySet<string>): string[] {
  return manifest.chunks.filter((c) => loaded.has(c.key) && centreDistance(c, pos) > UNLOAD_RADIUS).map((c) => c.key);
}

/** fetch that turns network failures (offline, DNS) and non-ok statuses into FetchError (status 0 for the former). */
export async function fetchOk(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new FetchError(url, 0);
  }
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
  /** Chunks whose download failed: how often, and when they may be retried (Infinity = given up). */
  private readonly failed = new Map<string, { count: number; retryAt: number }>();
  private queue: string[] = [];
  /** Buildings that carry a real shop sign: their facade sign band gets no pseudo lettering. */
  private signed = new Set<string>();
  private lastPos: XZ = { x: 0, z: 0 };
  /** Incremented whenever a chunk is added to or removed from the scene. */
  revision = 0;
  readonly facade = createFacadeMaterial();
  /** Emissive materials of loaded override models (stained glass …): dim by day, glowing at night. */
  private readonly glow = new Set<MeshStandardMaterial>();
  readonly street = createStreetMaterials();

  constructor(private readonly scene: Scene, private readonly baseUrl: string) {}

  /**
   * Loads the manifest (unless given: already being loaded elsewhere) and every chunk within READY_RADIUS of `start`
   * (default: the spawn); resolves when they are in the scene.
   */
  async init(
    onProgress: (p: number) => void, start?: XZ, onStatus: (text: string) => void = () => {}, manifestLoad?: Promise<WorldManifest>,
  ): Promise<WorldManifest> {
    onStatus('Karte …');
    const manifest = await (manifestLoad ?? fetchOk(`${this.baseUrl}manifest.json`).then(async (r) => parseManifest(await r.json())));
    this.manifest = manifest;
    this.signed = new Set(manifest.shops.flatMap((s) => (s.sign && s.buildingId ? [s.buildingId] : [])));
    const from = start ?? manifest.spawn;
    this.lastPos = { x: from.x, z: from.z };
    const keys = chunksToLoad(manifest, from, new Set(this.loaded.keys()), READY_RADIUS);
    let done = 0;
    onStatus(`Straßen und Häuser 0/${keys.length}`);
    onProgress(0);
    // MAX_CONCURRENT workers drain the initial list; errors abort init
    const list = [...keys];
    const worker = async (): Promise<void> => {
      for (let key = list.shift(); key !== undefined; key = list.shift()) {
        await this.load(key);
        onProgress(++done / keys.length);
        onStatus(`Straßen und Häuser ${done}/${keys.length}`);
      }
    };
    await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
    this.ready = true;
    return manifest;
  }

  /**
   * Unloads far chunks and starts downloads of near ones (at most MAX_CONCURRENT in flight).
   * A failed chunk is retried with backoff (RETRY_DELAYS_MS); `now` is in ms.
   */
  update(cameraPos: { x: number; z: number }, now = performance.now()): void {
    for (const mat of this.glow) mat.emissiveIntensity = 0.12 + 1.4 * this.facade.userData.nightFactor.value;
    const m = this.manifest;
    if (!m || !this.ready) return;
    this.lastPos = { x: cameraPos.x, z: cameraPos.z };
    for (const key of chunksToUnload(m, cameraPos, new Set(this.loaded.keys()))) this.unload(key);
    const waiting = [...this.failed].filter(([, f]) => f.retryAt > now).map(([key]) => key);
    const busy = new Set([...this.loaded.keys(), ...this.pending, ...waiting]);
    this.queue = chunksToLoad(m, cameraPos, busy);
    while (this.pending.size < MAX_CONCURRENT && this.queue.length > 0) {
      const key = this.queue.shift()!;
      this.load(key).then(
        () => this.failed.delete(key),
        (err: unknown) => {
          const count = (this.failed.get(key)?.count ?? 0) + 1;
          this.failed.set(key, { count, retryAt: nextRetryAt(count, now) ?? Infinity });
          console.error(err);
        },
      );
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
        disposeGltf(root); // its own materials and textures were not swapped for the shared ones yet
        return;
      }
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.name === 'buildings' ? this.facade : this.street[mesh.name];
        if (!mat) return;
        (mesh.material as Material).dispose();
        mesh.material = mat;
        mesh.receiveShadow = true; // ground and street meshes receive but do not cast (saves the shadow pass)
        if (mesh.name === 'buildings') {
          addEaveAttribute(mesh.geometry);
          markSigned(mesh.geometry, root.userData.buildings, this.signed);
          mesh.castShadow = true;
        } else mesh.renderOrder = STREET_RENDER_ORDER[mesh.name] ?? 0;
      });
      for (const model of this.manifest!.models.filter((x) => x.chunk === key)) root.add(await this.loadModel(model.file));
      root.matrixAutoUpdate = false;
      root.updateMatrixWorld(true);
      this.scene.add(root);
      this.loaded.set(key, root);
      this.revision++;
    } finally {
      this.pending.delete(key);
    }
  }

  /** Bike and rack models of the manifest (bike_<type>.glb, rack_*.glb), parsed once; templates to clone or instance. */
  async loadBikeModels(m: WorldManifest): Promise<{ bikes: Map<BikeType, Object3D>; racks: Map<0 | 1, Object3D> }> {
    const parse = async (file: string) => (await this.gltf.parseAsync(await (await fetchOk(`${this.baseUrl}${file}`)).arrayBuffer(), this.baseUrl)).scene;
    const [bikes, racks] = await Promise.all([
      Promise.all(m.bikeModels.map(async (b) => [b.type, await parse(b.file)] as const)),
      Promise.all(m.rackModels.map(async (r) => [r.kind, await parse(r.file)] as const)),
    ]);
    return { bikes: new Map(bikes), racks: new Map(racks) };
  }

  /** Car models of the manifest (car_<type>.glb + car_<type>_lod.glb), parsed once; templates to clone or instance. */
  async loadCarModels(m: WorldManifest): Promise<Map<CarType, { full: Object3D; lod: Object3D }>> {
    const parse = async (file: string) => (await this.gltf.parseAsync(await (await fetchOk(`${this.baseUrl}${file}`)).arrayBuffer(), this.baseUrl)).scene;
    const all = await Promise.all(m.carModels.map(async (c) => [c.type, { full: await parse(c.file), lod: await parse(c.lod) }] as const));
    return new Map(all);
  }

  /** Player character models of the manifest (character_<variant>.glb), each downloaded when first asked for. */
  characterModels(m: WorldManifest): CharacterModels {
    const parse = async (file: string) => (await this.gltf.parseAsync(await (await fetchOk(`${this.baseUrl}${file}`)).arrayBuffer(), this.baseUrl)).scene;
    return new CharacterModels(new Map(m.characterModels.map((c) => [c.variant, c.file])), parse);
  }

  /** A replacement model (world space, own materials); marked so unload() frees its materials too. */
  private async loadModel(file: string): Promise<Object3D> {
    const buf = await (await fetchOk(`${this.baseUrl}${file}`)).arrayBuffer();
    const model = (await this.gltf.parseAsync(buf, this.baseUrl)).scene;
    model.name = file;
    model.userData.ownMaterials = true;
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = true;
      for (const mat of [mesh.material].flat()) if (mat instanceof MeshStandardMaterial && mat.emissiveMap) this.glow.add(mat);
    });
    return model;
  }

  private unload(key: string): void {
    const root = this.loaded.get(key);
    if (!root) return;
    this.scene.remove(root);
    for (const model of root.children.filter((c) => c.userData.ownMaterials)) {
      model.traverse((c) => {
        for (const mat of [(c as Mesh).material ?? []].flat()) this.glow.delete(mat as MeshStandardMaterial);
      });
      disposeGltf(model);
    }
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

/** Frees everything of a freshly parsed GLTF: geometries, materials and the textures they use. */
export function disposeGltf(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(mat)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose();
      mat.dispose();
    }
  });
}

/** Frees geometries only; materials are shared across chunks. */
function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) mesh.geometry.dispose();
  });
}
