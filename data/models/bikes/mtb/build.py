"""Mountainbike (hardtail: sloping frame, suspension fork, wide riser bar, knobby 29" tyres, disc brakes).

Run inside Blender (MCP): exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/mtb/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import (Part, V, bike_materials, clear_default_scene, crankset, empty, handlebar, lamp,  # noqa: E402
                       pedal, reset_collection, run, saddle, wheel)

NAME = 'mtb'
R = 0.37                       # 29 × 2.3
RA = V((0, 0.575, R))
FA = V((0, -0.575, R))
BB = V((0, 0.14, 0.33))
ST = V((0, 0.28, 0.78))
SEAT = V((0, 0.32, 0.97))
HT_TOP = V((0, -0.42, 0.95))   # fork pivot
HT_BOT = V((0, -0.38, 0.79))


def build():
    clear_default_scene()
    coll = reset_collection('BIKE_MTB')
    M = bike_materials()

    f = Part('frame')
    f.tube([BB, V((0, -0.1, 0.52)), HT_BOT + V((0, 0, 0.02))], 0.025, M['paint'])
    f.tube([ST + V((0, -0.01, -0.06)), V((0, -0.1, 0.82)), HT_TOP - V((0, 0, 0.03))], 0.019, M['paint'])
    f.tube([HT_BOT, HT_TOP], 0.024, M['paint'])
    f.tube([BB, ST], 0.019, M['paint'])
    for s in (-1, 1):
        f.tube([BB + V((s * 0.03, 0, 0)), RA + V((s * 0.07, 0, 0))], 0.011, M['paint'])
        f.tube([ST + V((s * 0.02, 0, -0.08)), RA + V((s * 0.07, 0, 0))], 0.01, M['paint'])
    f.cyl(ST, SEAT, 0.016, M['dark'])
    saddle(f, M, SEAT, 'sport')
    for z0, z1 in ((0.43, 0.42), (0.23, 0.34)):
        f.cyl(V((-0.05, BB.y, z0)), V((-0.05, RA.y, z1)), 0.004, M['metal'], seg=4, caps=False)
    f.box(V((-0.055, RA.y + 0.02, R - 0.1)), (0.02, 0.06, 0.1), M['dark'])
    f.box(V((0.08, RA.y - 0.02, R + 0.06)), (0.015, 0.06, 0.04), M['dark'])  # brake caliper
    frame = f.to_object(coll)

    fk = Part('fork')
    off = -HT_TOP
    crown = HT_BOT + off + V((0, -0.01, -0.03))
    fk.box(crown, (0.16, 0.05, 0.035), M['dark'])
    for s in (-1, 1):
        top = crown + V((s * 0.06, 0, 0))
        mid = V((s * 0.06, -0.47, 0.6)) + off
        fk.cyl(top, mid, 0.017, M['metal'], seg=12)                                   # stanchion
        fk.cyl(mid + V((0, 0.0, 0.03)), FA + off + V((s * 0.06, 0, 0)), 0.024, M['dark'], seg=12)  # lower
    fk.box(FA + off + V((0.08, 0.04, 0.06)), (0.015, 0.06, 0.04), M['dark'])           # brake caliper
    fk.cyl(V((0, 0, 0.0)), V((0, 0, 0.05)), 0.018, M['dark'])
    fk.cyl(V((0, 0, 0.045)), V((0, -0.06, 0.06)), 0.018, M['dark'])                  # short stem
    grips = handlebar(fk, M, V((0, -0.07, 0.065)), 'riser', 0.76)
    fork = fk.to_object(coll, frame, HT_TOP)

    for name, pos, parent in (('wheel_front', FA, fork), ('wheel_rear', RA, frame)):
        w = Part(name)
        wheel(w, M, R, tyre_w=0.058, spokes=28, knobby=True, rim='dark')
        w.disc_x((0.06, 0, 0), 0.08, 0.003, M['metal'], seg=24)                       # brake rotor
        if name == 'wheel_rear':
            w.disc_x((-0.05, 0, 0), 0.06, 0.025, M['metal'], seg=16)
        w.to_object(coll, parent, pos)

    cp = Part('crank')
    pl, pr = crankset(cp, M, ring_r=0.085)
    crank = cp.to_object(coll, frame, BB)
    for name, p in (('pedal_l', pl), ('pedal_r', pr)):
        pp = Part(name)
        pedal(pp, M)
        pp.to_object(coll, crank, BB + p)

    lf = Part('light_front')
    lamp(lf, M, 'front')
    lf.to_object(coll, fork, HT_TOP + V((0.07, -0.08, 0.06)))
    lr = Part('light_rear')
    lamp(lr, M, 'rear')
    lr.to_object(coll, frame, V((0, 0.31, 0.88)))

    empty(coll, 'seat', SEAT + V((0, 0.03, 0.06)), frame)
    empty(coll, 'grip_l', HT_TOP + grips[0], fork)
    empty(coll, 'grip_r', HT_TOP + grips[1], fork)
    return frame


result = run(NAME, HERE, build, (1.75, 2.0))
