"""Bike rack hoops: rack_hoop (stainless inverted U with a cross bar, kind 0) and rack_wall (dark bollard with a
lock ring, kind 1, for wall loops/bollards).

Run inside Blender (MCP): exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/racks/build.py
Frame: origin on the ground at the hoop centre; the hoop's long side runs along Y (= the direction bikes stand in).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import Part, V, bike_materials, clear_default_scene, export_bike, render, reset_collection  # noqa: E402

import bpy  # noqa: E402

R = 0.024        # Ø 48 mm tube


def hoop(M):
    p = Part('rack_hoop')
    half, top, bend = 0.45, 0.8, 0.14
    pts = [V((0, -half, -0.05)), V((0, -half, top - bend))]
    for i in range(1, 8):
        a = math.pi / 2 * i / 8
        pts.append(V((0, -half + bend - bend * math.cos(a), top - bend + bend * math.sin(a))))
    pts += [V((0, -half + bend, top)), V((0, half - bend, top))]
    for i in range(1, 8):
        a = math.pi / 2 * i / 8
        pts.append(V((0, half - bend + bend * math.sin(a), top - bend + bend * math.cos(a))))
    pts += [V((0, half, top - bend)), V((0, half, -0.05))]
    p.tube(pts, R, M['metal'], seg=12)
    p.cyl(V((0, -half, 0.35)), V((0, half, 0.35)), R * 0.8, M['metal'], seg=10)
    for y in (-half, half):
        p.cyl(V((0, y, 0.0)), V((0, y, 0.012)), 0.05, M['metal'], seg=12)       # base plates
    return p


def bollard(M):
    p = Part('rack_wall')
    p.cyl(V((0, 0, -0.05)), V((0, 0, 0.9)), 0.08, M['dark'], seg=16)
    p.cyl(V((0, 0, 0.9)), V((0, 0, 0.93)), 0.06, M['dark'], seg=16)
    p.cyl(V((0, 0, 0.74)), V((0, 0, 0.8)), 0.082, M['reflector'], seg=16)
    p.torus_x(V((0, 0.11, 0.55)), 0.06, 0.012, M['metal'], seg=20, rseg=6)   # lock ring
    return p


def build():
    clear_default_scene()
    coll = reset_collection('RACK_MODELS')
    M = bike_materials()
    objs = {}
    for name, make, x in (('rack_hoop', hoop, 0.0), ('rack_wall', bollard, 0.8)):
        ob = make(M).to_object(coll)
        objs[name] = ob
    for name, ob in objs.items():
        export_bike(os.path.join(HERE, f'{name}.glb'), ob)
    objs['rack_wall'].location.x = 0.8  # side by side for the review stills only (export happened at the origin)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'racks.blend'))
    repo = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
    shots = {'34': (V((-2.2, -2.4, 1.4)), V((0.4, 0, 0.4)))}
    return {'ok': True, 'shots': render('racks', os.path.join(repo, 'shots', 'bikes'), shots)}


result = build()
