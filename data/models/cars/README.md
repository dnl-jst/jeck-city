# Car models

Four parked/driveable car types (`CAR_TYPES` in `packages/shared/src/physics/cartypes.ts`): `kleinwagen` (compact
hatchback), `mittelklasse` (saloon), `transporter` (panel van, sliding door on the right), `smart` (city two-seater).
Each has a `build.py` that regenerates `<name>.blend`, `<name>.glb` and the distance version `<name>_lod.glb`
(change the script, not the .blend). Shared helpers (body loft, wheel arches, decals, wheels, mirrors) are in
`carparts.py`.

```sh
blender -b --factory-startup --python data/models/cars/<name>/build.py
```

Each run renders review stills (Workbench) to `shots/cars/<name>-{34,side,rear,front,grid}.png` and prints
`CAR_REPORT` (size, triangles) and `DECAL_MISS` for decals whose rays missed the body.

## Conventions

- Metres, Blender Z up, **ground z = 0**, origin on the ground midway between the axles; the car faces **−Y**
  (glTF +z), its left is +X.
- Dimensions, wheelbase, track and wheel radius must match `CAR_SPECS` (physics collider and ray-cast wheels).
- glTF binary, no Draco; the pipeline adds meshopt and ships `car_<type>.glb` / `car_<type>_lod.glb`.

## Nodes and materials (the client uses them by name)

| Name | Meaning |
|---|---|
| `body` | root: body shell; children `decals` (lamps, plates, seams…) and `details` (mirrors, wipers…) |
| `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr` | wheel hubs; spin about X, front ones steer about the vertical |
| `light_fl`, `light_fr`, `tail_l`, `tail_r` | empties at the lamp centres: headlight beams, tail glow, glare |
| material `paint` | body colour, recoloured per car |
| materials `lamp_front`, `lamp_rear` | glow at night / when braking (driven car only) |

The body is a loft of cross-sections (`top`, `belt`, `bottom`, `width`, `topw` tables over `u` = metres ahead of
the origin), smoothed by Subdivision Surface, wheel arches cut by a Boolean. Window faces come from the `side` and
`topglass` u-ranges; everything stuck onto the panels is a decal ray-cast onto the finished body.
