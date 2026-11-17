# Hand-made building models

`data/building-overrides.json` maps a LOD2 building id to a replacement model:

```json
{ "DENW37AL1000AEDb": "data/models/st-marien/st-marien.glb" }
```

Several ids may point to the same GLB when LOD2 splits one structure into parts; the model is shipped once.

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

## Building a model

Each model has a `build.py` that generates its `.blend` and `.glb` (it overwrites both, so change the script,
not the .blend). Shared helpers – builder with world-scale UVs, procedural textures, prisms, wall panels,
glTF export – are in `nnmodel.py`. Headless:

```sh
cd data/models/<name> && blender -b --factory-startup --python-expr \
  "P='$PWD/build.py'; exec(open(P).read(), {'__file__': P})"
```

## Models

| Id | Model | Source |
|---|---|---|
| DENW37AL1000AEDb | `st-marien/` – St. Marien, Baudriplatz | LOD2 footprint, street photos |
| DENW37AL1000APxJ, …BdpH, …Bdpd | `wilhelmplatz-tribuene/` – Tribüne with WC and kiosk, Wilhelmplatz | LOD2 footprint/heights, street photos, aerial |
| DENW37AL1000AJzb, …AKKj, …BVEZ, …AKt2 | `neusser-florastrasse/` – the four buildings round the square at U Florastraße, Neusser Str. | LOD2 footprints/heights, street photos |
| DENW37AL1000eZaq, …eVXe | `erft-haus/` – Erft-Haus, Neusser Str. 27–29 (Agnesviertel), with the passage to the courtyard | LOD2 footprint/heights, street photo |
| DENW37AL1000qmxq | `koelner-dom/` – Kölner Dom with the Domtreppe to the Bahnhofsvorplatz | plan (Commons, to scale), LOD2 axis/towers, DGM1 (Domplatte, stairs), photos (Commons) |
