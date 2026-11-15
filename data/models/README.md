# Hand-made building models

`data/building-overrides.json` maps a LOD2 building id to a replacement model:

```json
{ "DENW37AL1000AEDb": "data/models/st-marien/st-marien.glb" }
```

The pipeline (`npm run pipeline`) then drops that building from the chunks and collision, ships the model as
`apps/client/public/world/model_<name>.glb`, and the client loads it together with the chunk of the building.

## Model conventions

- **glTF binary (.glb)**, no Draco (the client only decodes Meshopt; the pipeline compresses).
- **World coordinates, metres.** Blender X = game x (east), Blender Y = north (= −game z), Z up; export with
  "+Y Up" (the default). Ground is z 0; sidewalks are at 0.12. Let walls reach ~0.3 m below ground.
  The pipeline refuses a model whose centre is more than 25 m from the LOD2 building (wrong frame).
  Object transforms are fine (they are baked); scale should be 1.
- **Collision:** objects whose name ends in `_col` go only into collision.bin (keep them coarse: boxes,
  roof planes). Without any `_col` object the visible meshes are used.
- **Materials:** Principled BSDF only (base colour, roughness, metallic, emission; image textures allowed).
  Few materials, textures ≤ 1024 px. Materials with an *emission texture* glow at night (the client scales
  their emissive intensity with the night factor) – use that for stained or lit windows.
- Don't name meshes `buildings`, `road`, `sidewalk`, `curb`, `tram`, `green`, `squares` or `trackbed`.

## Getting the LOD2 reference

Building ids and their LOD2 geometry come from `data/raw/lod2/*.gml` (fetched by the pipeline).
Game coordinates: `utmToLocal` in `packages/shared/src/geo.ts`; heights are relative to the building's
lowest ground point.

## Models

| Id | Model | Source |
|---|---|---|
| DENW37AL1000AEDb | `st-marien/` – St. Marien, Baudriplatz | `build.py` generates the .blend and .glb (run it in Blender; it overwrites both) |
