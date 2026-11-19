# Car models

Four parked/driveable car types (`CAR_TYPES` in `packages/shared/src/physics/cartypes.ts`): `kleinwagen` (compact
hatchback), `mittelklasse` (saloon), `transporter` (panel van, sliding door on the right), `smart` (city two-seater).
Each has a `build.py` that regenerates `<name>.blend`, `<name>.glb` and the distance version `<name>_lod.glb`
(change the script, not the .blend).

```sh
blender -b --factory-startup --python data/models/cars/<name>/build.py
npm run ship-cars     # re-encodes all car models into apps/client/public/world and updates its manifest
npm run car-shots -- <dev server url> shots/cars/ingame   # in-game stills and a frame-time line (FRAME_MS)
```

Each run renders review stills to `shots/cars/<name>-*.png` and prints `CAR_REPORT` (size, triangles, seats) and
`DECAL_MISS` / `RECESS_MISS` for decals and recesses whose rays missed the body.

## Two generations of scripts

- **Rebuilt (`kleinwagen`)**: `carbody.py` (shell with real window openings, clear glass, doors of their own, wall
  thickness, recessed lamps, the distance model) and `carinterior.py` (floor, dashboard, steering wheel, seats, door
  panels, seat nodes, the review manikins), on top of the loft and helpers of `carparts.py`. `build(coll, lod)` builds
  the full model or, with `lod`, the closed skin with opaque glass and flat lamps. Extra stills: `open` (doors open),
  `through` (eye level through the glass), `cut` (from above, roof clipped), `seated*` (a 1.78 m manikin on every seat).
- **Old (`mittelklasse`, `transporter`, `smart`)**: `carparts.py` alone – a closed body with opaque glass faces, no
  interior. They move to the new scripts next.

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
| `door_fl`, `door_fr`, `door_rl`, `door_rr` | rebuilt models: doors, origin on the hinge axis (front edge), swing about the vertical; their panes, handles, mirrors and inner panels are their children |
| `interior` | rebuilt models: everything inside (one mesh) |
| `steering` | steering wheel, origin in the hub, local Z along the column; children `grip_l`, `grip_r` (empties on the rim) |
| `seat_0` … `seat_n` | empties at the hip point of each seat: driver, front passenger, rear left, rear right |
| material `paint` | body colour, recoloured per car |
| material `glass` | window panes. Rebuilt models: clear (alphaMode BLEND; the client draws it without depth writes). Old models: opaque |
| materials `lens`, `lens_red` | clear lamp covers (treated like clear glass) |
| materials `interior`, `interior_trim`, `seat`, `pillar`, `rubber` | interior surfaces, gloss black window pillars, the reveals of openings |
| material `glass_dark` | the distance model's opaque glass |
| materials `lamp_front`, `lamp_rear` | glow at night / when braking (driven car only) |

Seats and doors are defined once, in `CAR_SEATS` (`packages/shared/src/physics/carseats.ts`: hip points, hinge
axes, open angle); the build script uses the same numbers and `apps/client/src/car-model-nodes.test.ts` checks the
exported nodes against them. Change both together.

The body is a loft of cross-sections (`top`, `belt`, `bottom`, `width`, `topw` tables over `u` = metres ahead of
the origin), smoothed by Subdivision Surface, wheel arches cut by a Boolean. Window faces come from the `side` and
`topglass` u-ranges; everything stuck onto the panels is a decal ray-cast onto the finished body.
