import { Box3, BufferGeometry, DoubleSide, type Material, type MeshPhongMaterial, MeshStandardMaterial, Vector3 } from 'three';

/** Height (m) of a street tree at scale 1 (treeScale). */
export const TREE_HEIGHT = 12;
/** Trunk radius at the foot (m) at scale 1; matches the trunk collider (tuning trunkRadius). */
export const TREE_TRUNK_RADIUS = 0.24;
/** Lowest branches start at least this far up the trunk (fraction): clear space over sidewalks. */
const BRANCH_START = 0.4;

/** Bark and leaf-card geometry of one detail level, origin at the foot of the trunk. */
export interface TreeLevel { bark: BufferGeometry; leaves: BufferGeometry }

/** One street tree model: full detail (near), a lighter one with the same shape (far), and its materials. */
export interface TreeVariant {
  near: TreeLevel;
  far: TreeLevel;
  barkMat: MeshStandardMaterial;
  leafMat: MeshStandardMaterial;
}

/** EZ-Tree presets (MIT, github.com/dgreenheck/ez-tree) and seeds of the variants; deciduous like Köln's street trees. */
const VARIANTS: { preset: string; seed: number }[] = [
  { preset: 'Ash Large', seed: 29919 },
  { preset: 'Oak Large', seed: 4127 },
  { preset: 'Ash Medium', seed: 7713 },
  { preset: 'Oak Medium', seed: 1907 },
];

const phong = (m: Material | Material[]): MeshPhongMaterial => (Array.isArray(m) ? m[0] : m) as MeshPhongMaterial;
const bounds = (g: BufferGeometry): Box3 => new Box3().setFromBufferAttribute(g.getAttribute('position') as never);

/**
 * Generates a preset. `far`: fewer segments round each branch and single instead of crossed leaf cards (a little
 * larger) — segment count and billboard type draw no random numbers, so the tree keeps exactly the same shape.
 */
function grow(Tree: TreeCtor, preset: string, seed: number, far: boolean): Tree {
  const tree = new Tree();
  tree.loadPreset(preset);
  const o = tree.options;
  o.seed = seed;
  const start = o.branch.start as Record<number, number>, segs = o.branch.segments as Record<number, number>;
  for (const k of [1, 2, 3]) start[k] = Math.max(start[k]!, BRANCH_START);
  if (far) {
    for (const k of [0, 1, 2, 3]) segs[k] = Math.max(3, Math.ceil(segs[k]! / 2));
    o.leaves.billboard = 'single';
    o.leaves.size *= 1.3;
  }
  tree.generate();
  return tree;
}

type TreeCtor = typeof import('@dgreenheck/ez-tree').Tree;
type Tree = InstanceType<TreeCtor>;

/**
 * Generates the tree variants (procedural, a few ms each), scaled to TREE_HEIGHT with a TREE_TRUNK_RADIUS trunk.
 * EZ-Tree is imported lazily: it starts loading its textures (DOM images) on import.
 */
export async function loadTreeVariants(): Promise<TreeVariant[]> {
  const { Tree } = await import('@dgreenheck/ez-tree');
  return VARIANTS.map(({ preset, seed }) => {
    const near = grow(Tree, preset, seed, false), far = grow(Tree, preset, seed, true);
    const box = bounds(near.branchesMesh.geometry).union(bounds(near.leavesMesh.geometry));
    const s = TREE_HEIGHT / (box.max.y - box.min.y);
    // slimmer trunk and branches: scale across by the trunk radius, but not so much that the crown gets narrow
    const sx = Math.max(s * 0.75, Math.min(s, TREE_TRUNK_RADIUS / near.options.branch.radius[0]!));
    const crown = bounds(near.leavesMesh.geometry);
    const c = crown.getCenter(new Vector3()).multiply(new Vector3(sx, s, sx));
    c.y = s * (crown.min.y + 0.4 * (crown.max.y - crown.min.y));
    const level = (t: Tree): TreeLevel => {
      const bark = t.branchesMesh.geometry, leaves = t.leavesMesh.geometry;
      bark.scale(sx, s, sx);
      leaves.scale(sx, s, sx);
      // soft crown lighting: leaf normals point away from the crown centre instead of along the cards
      const pos = leaves.getAttribute('position'), nrm = leaves.getAttribute('normal');
      const v = new Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).sub(c);
        v.y *= 0.6;
        v.normalize();
        nrm.setXYZ(i, v.x, v.y, v.z);
      }
      nrm.needsUpdate = true;
      bark.computeBoundingSphere();
      leaves.computeBoundingSphere();
      return { bark, leaves };
    };
    const pb = phong(near.branchesMesh.material), pl = phong(near.leavesMesh.material);
    const barkMat = new MeshStandardMaterial({ map: pb.map, normalMap: pb.normalMap, roughnessMap: (pb as unknown as MeshStandardMaterial).roughnessMap, color: pb.color, roughness: 1 });
    const leafMat = new MeshStandardMaterial({ map: pl.map, color: pl.color, alphaTest: pl.alphaTest, side: DoubleSide, roughness: 0.75 });
    for (const t of [near, far]) {
      for (const m of [t.branchesMesh.material, t.leavesMesh.material]) phong(m).dispose();
    }
    return { near: level(near), far: level(far), barkMat, leafMat };
  });
}
