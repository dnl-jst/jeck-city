"""Rennrad (road bike: diamond frame with a sloping top tube, drop bar, deep rims, slim tyres): procedural bike model.

Run inside Blender (MCP): exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/road/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import (Part, V, bike_materials, clear_default_scene, crankset, empty, handlebar, lamp,  # noqa: E402
                       pedal, reset_collection, run, saddle, wheel)

NAME = 'road'
R = 0.34                       # 700c × 25
RA = V((0, 0.5, R))
FA = V((0, -0.5, R))
BB = V((0, 0.09, 0.27))
ST = V((0, 0.25, 0.80))
SEAT = V((0, 0.30, 0.96))
HT_TOP = V((0, -0.36, 0.89))   # fork pivot
HT_BOT = V((0, -0.32, 0.72))


def build():
    clear_default_scene()
    coll = reset_collection('BIKE_ROAD')
    M = bike_materials()

    f = Part('frame')
    f.tube([BB, HT_BOT + V((0, 0, 0.02))], 0.022, M['paint'])                 # down tube (oversized)
    f.tube([ST + V((0, -0.01, -0.03)), HT_TOP - V((0, 0, 0.03))], 0.016, M['paint'])   # sloping top tube
    f.tube([HT_BOT, HT_TOP], 0.02, M['paint'])
    f.tube([BB, ST], 0.017, M['paint'])
    for s in (-1, 1):
        f.tube([BB + V((s * 0.025, 0, 0)), RA + V((s * 0.06, 0, 0))], 0.009, M['paint'])
        f.tube([ST + V((s * 0.015, 0, -0.05)), RA + V((s * 0.06, 0, 0))], 0.008, M['paint'])
    f.cyl(ST, SEAT, 0.0135, M['dark'])
    saddle(f, M, SEAT, 'race')
    f.cyl(V((0, 0.1, 0.5)), V((0, 0.0, 0.62)), 0.018, M['dark'], seg=10)      # bottle on the down tube
    for z0, z1 in ((0.37, 0.39), (0.18, 0.31)):
        f.cyl(V((-0.05, BB.y, z0)), V((-0.05, RA.y, z1)), 0.004, M['metal'], seg=4, caps=False)
    f.box(V((-0.05, RA.y + 0.02, R - 0.09)), (0.02, 0.05, 0.08), M['dark'])  # rear derailleur
    frame = f.to_object(coll)

    fk = Part('fork')
    off = -HT_TOP
    for s in (-1, 1):
        fk.tube([HT_BOT + off + V((s * 0.025, 0, -0.01)), V((s * 0.045, -0.4, 0.55)) + off, FA + off + V((s * 0.05, 0, 0))], 0.011, M['paint'])
    fk.cyl(V((0, 0, 0.0)), V((0, 0, 0.04)), 0.016, M['dark'])
    fk.cyl(V((0, 0, 0.035)), V((0, -0.1, 0.045)), 0.015, M['dark'])                 # stem
    grips = handlebar(fk, M, V((0, -0.11, 0.045)), 'drop', 0.42)
    fork = fk.to_object(coll, frame, HT_TOP)

    wf = Part('wheel_front')
    wheel(wf, M, R, tyre_w=0.026, spokes=20, rim='dark')
    wf.to_object(coll, fork, FA)
    wr = Part('wheel_rear')
    wheel(wr, M, R, tyre_w=0.026, spokes=24, rim='dark')
    wr.disc_x((-0.05, 0, 0), 0.05, 0.02, M['metal'], seg=16)                     # cassette
    wr.to_object(coll, frame, RA)

    cp = Part('crank')
    pl, pr = crankset(cp, M, ring_r=0.11)
    crank = cp.to_object(coll, frame, BB)
    for name, p in (('pedal_l', pl), ('pedal_r', pr)):
        pp = Part(name)
        pedal(pp, M)
        pp.to_object(coll, crank, BB + p)

    lf = Part('light_front')
    lamp(lf, M, 'front')
    lf.to_object(coll, fork, HT_TOP + V((0.06, -0.12, 0.0)))
    lr = Part('light_rear')
    lamp(lr, M, 'rear')
    lr.to_object(coll, frame, V((0, 0.29, 0.87)))

    empty(coll, 'seat', SEAT + V((0, 0.03, 0.06)), frame)
    empty(coll, 'grip_l', HT_TOP + grips[0], fork)
    empty(coll, 'grip_r', HT_TOP + grips[1], fork)
    return frame


result = run(NAME, HERE, build, (1.65, 1.85))
