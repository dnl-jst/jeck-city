# Car models

Four parked/driveable car types (`CAR_TYPES` in `packages/shared/src/physics/cartypes.ts`): `kleinwagen` (compact
hatchback), `mittelklasse` (saloon), `transporter` (panel van, sliding door on the right), `smart` (city two-seater).
Each has a `build.py` that regenerates `<name>.blend`, `<name>.glb` and the distance version `<name>_lod.glb`
(change the script, not the .blend).

```sh
blender -b --factory-startup --python data/models/cars/<name>/build.py
npm run ship-cars     # re-encodes all car models into apps/client/public/world and updates its manifest
npm run car-shots -- <dev server url> shots/cars/ingame   # in-game stills and a frame-time line (FRAME_MS)
npm run board-shots -- <dev server url> shots/cars/board  # stills of getting in, driving with the figure at the wheel, getting out
```

Each run renders review stills to `shots/cars/<name>-*.png` and prints `CAR_REPORT` (size, triangles, seats) and
`DECAL_MISS` / `RECESS_MISS` for decals and recesses whose rays missed the body.

## How the scripts are split

- `carparts.py`: the loft (cross-section tables → subdivided skin with wheel arches), decals, wheels, export helpers.
- `carbody.py`: the shell on top of it – real window openings, clear glass, doors of their own with seals behind
  their gaps, wall thickness, recessed lamps, mirrors, arch lips, handles, the distance model, review stills, `run2`.
- `carinterior.py`: floor, dashboard, steering wheel, seats / bench, bulkhead, door panels, the seat nodes, and the
  1.78 m review manikins.

Each type's `build(coll, lod)` builds the full model or, with `lod`, the closed skin with opaque glass and flat lamps.
Stills per type: `34`, `side`, `rear`, `front`, `grid`, `open` (doors open), `through` (eye level through the glass),
`cut` (from above, roof clipped), `seated*` (a manikin on every seat).

Lessons built into the scripts: a front door ends at the foot of the windscreen (its window frame must not reach onto
the wing); a door that a wheel arch cuts is fine at the front (smart, transporter) but leaves slivers where it only
clips the arch, so rear doors end either well over the arch (kleinwagen) or just ahead of it (mittelklasse); the
dashboard ends under the windscreen foot or its corners come through the bonnet.

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
| `door_fl`, `door_fr`, `door_rl`, `door_rr` | doors (two-door types: only the front pair), origin on the hinge axis (front edge), swing about the vertical; their panes, handles, mirrors and inner panels are their children |
| `interior` | everything inside (one mesh) |
| `steering` | steering wheel, origin in the hub, local Z along the column; children `grip_l`, `grip_r` (empties on the rim) |
| `seat_0` … `seat_n` | empties at the hip point of each seat: driver, front passenger, rear left, rear right |
| `plate_f`, `plate_r` | empties where the game draws the lettered number plates (`apps/client/src/plates.ts`): local −Y outwards, Z up; the models' own plates stay blank |
| material `paint` | body colour, recoloured per car |
| material `glass` | window panes: clear (alphaMode BLEND; the client draws it without depth writes) |
| material `mirror` | mirror glass; the client gives it a sky-and-street reflection |
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
