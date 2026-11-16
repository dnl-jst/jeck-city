# Player characters

`build.py` generates `character_man.glb` and `character_woman.glb` (plus `.blend`) with **MPFB2** (MakeHuman for
Blender) and renders review stills to `shots/character/`. The pipeline ships them (meshopt) as
`public/world/character_<variant>.glb`, listed in the manifest's `characterModels`; `npx tsx
packages/pipeline/src/characters.ts` updates only those in an existing world. In game, **C** switches the figure; only
the shown one is downloaded at start.

## Setup

1. Blender extension **MPFB** (extensions.blender.org).
2. MakeHuman system assets (CC0 for releases) in MPFB's user data dir
   `~/.config/blender/<ver>/extensions/.user/blender_org/mpfb/data/<type>/<name>/`. The official asset packs
   (files.makehumancommunity.org) were unreachable in Nov 2026; the same files are in the GitHub mirror
   `dmaugis/makehuman-py3-assets` (`base/…`, textures via Git LFS). Needed: skins `young_caucasian_male`,
   `young_caucasian_female` (+ their `skins/textures/young_lightskinned_*_diffuse*.png`), `eyes/materials`,
   eyebrows `eyebrow001`, `eyebrow012`, eyelashes `eyelashes01`, `eyelashes02`, hair `short02`, `ponytail01`,
   clothes `male_casualsuit05`, `female_casualsuit01`, `shoes05`, `shoes06`. The eye meshes (`eyes/high-poly`) come
   from `makehumancommunity/makehuman` (`makehuman/data/eyes`).
3. In Blender: `exec(open(PATH).read(), {'__file__': PATH})` (MCP or text editor).

## Model contract (apps/client/src/player.ts)

- Metres, feet on the ground, facing game +z; rest pose standing straight with the arms hanging (build.py poses MPFB's
  A-pose into this and applies it as rest).
- Bones of MPFB's `game_engine` rig. The client reads the joint layout from `thigh_l`, `calf_l`, `ball_l`, `spine_01`,
  `head`, `upperarm_l`, `lowerarm_l`, `hand_l`, `middle_01_l` and drives `pelvis`, `spine_01`, `head`,
  `thigh_*`, `calf_*`, `upperarm_*`, `lowerarm_*`; all other bones keep their rest offsets.
- Textures ≤ 2048 px, WebP (`EXT_texture_webp`); the eyes' cornea is alpha-clipped.
