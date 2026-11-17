# Traffic light models

`build.py` regenerates `signals.blend` and the three models (change the script, not the .blend):

```sh
blender -b --factory-startup --python data/models/signals/build.py
```

Each run also renders review stills (Workbench, lamps lit) to `shots/signals/<kind>-{34,front}.png`.

| File | Pole kind | What |
|---|---|---|
| `signal_car.glb` | `car` | 3.5 m pole, car head (red, amber, green) with visors and a black contour plate with a white rim |
| `signal_ped.glb` | `ped` | 2.6 m pole, pedestrian head (red standing man above, green walking man below) |
| `signal_carped.glb` | `car+ped` | car pole with two pedestrian heads lower down, facing both ways across the crossing (±X) |

## Conventions

- Metres, Blender Z up, origin on the ground at the pole's foot. The car lights (and the `ped` head) face **−Y**
  (= game +z at heading 0); a pole's `heading` in signals.json is the direction its lights face.
- glTF binary, no Draco; the pipeline adds meshopt and ships them as `apps/client/public/world/signal_*.glb`
  (`manifest.signalModels`).

## Nodes and materials (the client switches the lights by name)

| Node / material | Lit when |
|---|---|
| `lamp_red`, `lamp_amber`, `lamp_green` | the pole's car group shows that light (red + amber together: red-amber) |
| `lamp_ped_red`, `lamp_ped_green` | the pole's pedestrian group is red / green (the men themselves are the lit meshes) |
| `pole` | static: pole, housings, plates, lenses |

Lamp materials carry their colour as emission colour at strength 0; the client turns the strength up.
The pole's collider is in the game physics (`TUNING.props.poleRadius`), not in the model.
