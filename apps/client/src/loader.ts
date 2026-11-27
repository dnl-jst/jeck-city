import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, type Material, type Object3D, type Scene, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CHUNK_SIZE, parseManifest, type BikeType, type CarType, type WorldManifest } from '@nn/shared';
import { CharacterModels } from './characters';
import type { WorldFiles } from './world-files';
import { addEaveAttribute, createFacadeMaterial, FLAG_SIGNED } from './materials/facade';
import { createStreetMaterials, STREET_RENDER_ORDER } from './materials/street';

export { fetchOk } from './world-files';

export const LOAD_RADIUS = 600;
/** Only chunks this close are awaited before the game is playable; the rest streams in afterwards. */
export const READY_RADIUS = 250;
export const UNLOAD_RADIUS = 800;
export const MAX_CONCURRENT = 2;
/** Chunks downloading at once while the camera is at least FAST_SPEED (m/s) fast: by car, tram or helicopter. */
export const FAST_CONCURRENT = 4;
export const FAST_SPEED = 12;
/** Loading is centred on where the camera will be in LEAD_S seconds, at most LEAD_MAX metres ahead. */
export const LEAD_S = 4;
export const LEAD_MAX = 200;
/** The tracked camera speed follows the measured one with this time constant (s): a camera orbit averages out. */
const VELOCITY_EASE_S = 0.5;
/** A step faster than this (m/s) or after a longer pause than this (s) is a jump, not a movement. */
const JUMP_SPEED = 250; // (the dev free-fly camera does 150 m/s)
const JUMP_PAUSE_S = 1;
/** Pause (ms) between decoding one downloaded chunk and the next: at least one frame is drawn in between. */
const DECODE_GAP_MS = 20;

/** Wait before the 1st, 2nd and 3rd retry of a chunk whose download failed; after that it stays missing. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;

type XZ = { x: number; z: number };

/** When (ms, same clock as `lastAt`) a chunk may be tried again after its `failures`-th failure at `lastAt`; null = never. */
export function nextRetryAt(failures: number, lastAt: number): number | null {
  const d = RETRY_DELAYS_MS[failures - 1];
  return d === undefined ? null : lastAt + d;
}

/** The camera's smoothed horizontal velocity (m/s) after it moved from `from` to `to` in `dt` seconds. */
export function trackVelocity(vel: XZ, from: XZ, to: XZ, dt: number): XZ {
  if (dt === 0) return vel;
  if (!(dt > 0) || dt > JUMP_PAUSE_S) return { x: 0, z: 0 };
  const vx = (to.x - from.x) / dt;
  const vz = (to.z - from.z) / dt;
  if (Math.hypot(vx, vz) > JUMP_SPEED) return { x: 0, z: 0 };
  const k = 1 - Math.exp(-dt / VELOCITY_EASE_S);
  return { x: vel.x + (vx - vel.x) * k, z: vel.z + (vz - vel.z) * k };
}

/** The point chunks are loaded and unloaded around: `pos` moved ahead along the velocity. */
export function loadCentre(pos: XZ, vel: XZ): XZ {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed === 0) return { x: pos.x, z: pos.z };
  const lead = Math.min(speed * LEAD_S, LEAD_MAX) / speed;
  return { x: pos.x + vel.x * lead, z: pos.z + vel.z * lead };
}

/** How many chunks may download at once at a camera speed (m/s). */
export function concurrentLoads(speed: number): number {
  return speed >= FAST_SPEED ? FAST_CONCURRENT : MAX_CONCURRENT;
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

/** Keys in `loaded` whose chunk centre is > `radius` from `pos`. */
export function chunksToUnload(manifest: WorldManifest, pos: XZ, loaded: ReadonlySet<string>, radius = UNLOAD_RADIUS): string[] {
  return manifest.chunks.filter((c) => loaded.has(c.key) && centreDistance(c, pos) > radius).map((c) => c.key);
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
  /**
   * Downloads run side by side, but only one chunk at a time is decoded and put into the scene (both on the main
   * thread), DECODE_GAP_MS apart: several that arrive together would otherwise stall a single frame for all of them.
   */
  private decoding: Promise<void> = Promise.resolve();
  /** Buildings that carry a real shop sign: their facade sign band gets no pseudo lettering. */
  private signed = new Set<string>();
  /** The camera at the last update(), when that was (ms; NaN before the first) and its smoothed velocity (m/s). */
  private lastPos: XZ = { x: 0, z: 0 };
  private lastAt = Number.NaN;
  private vel: XZ = { x: 0, z: 0 };
  /** Where loading and unloading are centred: the camera, moved ahead while it is fast (loadCentre). */
  private centre: XZ = { x: 0, z: 0 };
  /** Chunks load within this radius of `centre` and unload beyond the other (quality level). */
  private radii = { load: LOAD_RADIUS, unload: UNLOAD_RADIUS };
  /** Incremented whenever a chunk is added to or removed from the scene. */
  revision = 0;
  readonly facade = createFacadeMaterial();
  /** Emissive materials of loaded override models (stained glass …): dim by day, glowing at night. */
  private readonly glow = new Set<MeshStandardMaterial>();
  readonly street = createStreetMaterials();

  constructor(private readonly scene: Scene, private readonly files: WorldFiles) {}

  /** Load and unload radius (m) of a quality level; takes effect on the next update(). */
  setRadii(load: number, unload: number): void {
    this.radii = { load, unload: Math.max(unload, load) };
  }

  /**
   * Loads the manifest (unless given: already being loaded elsewhere) and every chunk within READY_RADIUS of `start`
   * (default: the spawn); resolves when they are in the scene.
   */
  async init(
    onProgress: (p: number) => void, start?: XZ, onStatus: (text: string) => void = () => {}, manifestLoad?: Promise<WorldManifest>,
  ): Promise<WorldManifest> {
    onStatus('Karte …');
    const manifest = await (manifestLoad ?? this.files.fetch('manifest.json').then(async (r) => parseManifest(await r.json())));
    this.manifest = manifest;
    this.signed = new Set(manifest.shops.flatMap((s) => (s.sign && s.buildingId ? [s.buildingId] : [])));
    const from = start ?? manifest.spawn;
    this.lastPos = { x: from.x, z: from.z };
    this.centre = { x: from.x, z: from.z };
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
   * Unloads far chunks and starts downloads of near ones, nearest first, around the camera moved ahead by a few seconds
   * of its movement – so the chunks in front arrive before they come into view (at most MAX_CONCURRENT in flight, more
   * when fast).
   * A failed chunk is retried with backoff (RETRY_DELAYS_MS); `now` is in ms.
   */
  update(cameraPos: { x: number; z: number }, now = performance.now()): void {
    for (const mat of this.glow) mat.emissiveIntensity = 0.12 + 1.4 * this.facade.userData.nightFactor.value;
    const m = this.manifest;
    if (!m || !this.ready) return;
    const pos = { x: cameraPos.x, z: cameraPos.z };
    this.vel = trackVelocity(this.vel, this.lastPos, pos, (now - this.lastAt) / 1000);
    this.lastPos = pos;
    this.lastAt = now;
    const centre = this.centre = loadCentre(pos, this.vel);
    for (const key of chunksToUnload(m, centre, new Set(this.loaded.keys()), this.radii.unload)) this.unload(key);
    const waiting = [...this.failed].filter(([, f]) => f.retryAt > now).map(([key]) => key);
    const busy = new Set([...this.loaded.keys(), ...this.pending, ...waiting]);
    this.queue = chunksToLoad(m, centre, busy, this.radii.load);
    const atOnce = concurrentLoads(Math.hypot(this.vel.x, this.vel.z));
    while (this.pending.size < atOnce && this.queue.length > 0) {
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

  /** Resolves when it is this caller's turn to decode, with the function that passes the turn on. */
  private decodeTurn(): Promise<() => void> {
    let pass!: () => void;
    const before = this.decoding;
    this.decoding = new Promise((resolve) => { pass = resolve; });
    return before.then(() => pass);
  }

  private async load(key: string): Promise<void> {
    const chunk = this.manifest!.chunks.find((c) => c.key === key);
    if (!chunk) throw new Error(`unknown chunk ${key}`);
    this.pending.add(key);
    try {
      const buf = await (await this.files.fetch(chunk.file)).arrayBuffer();
      const decoded = await this.decodeTurn();
      let root: Object3D;
      try {
        root = (await this.gltf.parseAsync(buf, '')).scene; // self-contained GLBs: no resource path
      } finally {
        setTimeout(decoded, DECODE_GAP_MS);
      }
      // the player may have moved away while this chunk was downloading
      if (centreDistance(chunk, this.centre) > this.radii.unload) {
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
    const parse = (file: string): Promise<Object3D> => this.parseModel(file);
    const [bikes, racks] = await Promise.all([
      Promise.all(m.bikeModels.map(async (b) => [b.type, await parse(b.file)] as const)),
      Promise.all(m.rackModels.map(async (r) => [r.kind, await parse(r.file)] as const)),
    ]);
    return { bikes: new Map(bikes), racks: new Map(racks) };
  }

  /** Car models of the manifest (car_<type>.glb + car_<type>_lod.glb), parsed once; templates to clone or instance. */
  async loadCarModels(m: WorldManifest): Promise<Map<CarType, { full: Object3D; lod: Object3D }>> {
    const parse = (file: string): Promise<Object3D> => this.parseModel(file);
    const all = await Promise.all(m.carModels.map(async (c) => [c.type, { full: await parse(c.file), lod: await parse(c.lod) }] as const));
    return new Map(all);
  }

  /** Player character models of the manifest (character_<variant>.glb), each downloaded when first asked for. */
  characterModels(m: WorldManifest): CharacterModels {
    return new CharacterModels(new Map(m.characterModels.map((c) => [c.variant, c.file])), (file) => this.parseModel(file));
  }

  /** Downloads and parses a self-contained GLB world file. */
  private async parseModel(file: string): Promise<Object3D> {
    return (await this.gltf.parseAsync(await (await this.files.fetch(file)).arrayBuffer(), '')).scene;
  }

  /** A replacement model (world space, own materials); marked so unload() frees its materials too. */
  private async loadModel(file: string): Promise<Object3D> {
    const model = await this.parseModel(file);
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
