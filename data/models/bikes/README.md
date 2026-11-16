# Bike and rack models

Each bike has a `build.py` in its own folder that regenerates `<name>.blend` and `<name>.glb` (change the script,
not the .blend). Shared parts (tubes, spoked wheels, saddles, handlebars, crankset, lamps, mudguards) and the node
check are in `bikeparts.py`; materials via `../nnmodel.py`.

```sh
blender -b --factory-startup --python data/models/bikes/<name>/build.py   # headless
```

or inside Blender (MCP): `exec(open(PATH).read(), {'__file__': PATH})`. Each run also renders review stills
(Workbench) to `shots/bikes/<name>-{34,side,top}.png`.

## Conventions

- Metres, Blender Z up, **ground z = 0**, origin on the ground midway between the wheel contact points.
- The bike faces **−Y** in Blender (= game +z, heading 0); wheels turn about X; rider's left = +X.
- glTF binary, no Draco; the pipeline adds meshopt.

## Nodes (the client animates them by name)

| Node | Parent | Pivot / meaning |
|---|---|---|
| `frame` | – | root, static parts (frame, saddle, rack, mudguards) |
| `fork` | frame | on the steering axis; turns with steering (trike: the whole box + front axle) |
| `bar` | frame | optional: handlebar that steers separately (Long John) |
| `wheel_front` / `wheel_rear` | fork / frame | hub; spins about X (trike: `wheel_front_l`, `wheel_front_r`) |
| `crank` | frame | bottom bracket; spins about X with pedalling |
| `pedal_l`, `pedal_r` | crank | pedal axle (the client counter-rotates them to stay level) |
| `light_front`, `light_rear` | frame/fork | lamps; materials `lamp_front` / `lamp_rear` glow at night |
| `seat`, `grip_l`, `grip_r` | frame / bar | empties: where the rider sits and holds the bar |
| `disco` | frame | optional: mirror ball (sound Long John); spins about the vertical when switched on (L) |

Material `paint` is the frame colour; the client recolours it per bike. Material `mirror` (disco ball) shimmers while the ball is on.

`soundjohn/` reuses `longjohn/build.py` (`build(coll_name, cargo)`) and adds the sound box and the disco ball; there is
exactly one in the world (pipeline `SOUND_BIKE`, in front of Neusser Str. 381), and riding it plays the radio.
