"""Hollandrad (Dutch city bike: step-through frame, swept bar, front basket, rack, chain guard): procedural bike model.

Run inside Blender (MCP): exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/dutch/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import (Part, V, bike_materials, clear_default_scene, crankset, empty, fender, handlebar, lamp,  # noqa: E402
                       pedal, reset_collection, run, saddle, wheel)

NAME = 'dutch'
R = 0.35                       # 28" wheel
RA = V((0, 0.56, R))
FA = V((0, -0.56, R))
BB = V((0, 0.12, 0.29))
ST = V((0, 0.27, 0.80))
SEAT = V((0, 0.31, 0.98))
HT_TOP = V((0, -0.40, 0.98))   # fork pivot
HT_BOT = V((0, -0.36, 0.76))


def build():
    clear_default_scene()
    coll = reset_collection('BIKE_DUTCH')
    M = bike_materials()

    f = Part('frame')
    f.tube([HT_BOT + V((0, 0.01, 0.02)), V((0, -0.22, 0.48)), V((0, -0.05, 0.33)), BB], 0.022, M['paint'])   # low down tube
    f.tube([HT_BOT + V((0, 0.0, 0.12)), V((0, -0.2, 0.62)), V((0, 0.05, 0.47)), V((0, 0.19, 0.5))], 0.019, M['paint'])  # step-through tube
    f.tube([HT_BOT, HT_TOP - V((0, 0, 0.04))], 0.024, M['paint'])
    f.tube([BB, ST], 0.02, M['paint'])
    for s in (-1, 1):
        f.tube([BB + V((s * 0.03, 0, 0)), RA + V((s * 0.065, 0, 0))], 0.011, M['paint'])
        f.tube([ST + V((s * 0.02, 0.0, -0.06)), RA + V((s * 0.065, 0, 0))], 0.01, M['paint'])
        f.tube([RA + V((s * 0.07, 0, 0)), V((s * 0.07, 0.48, 0.78)), V((s * 0.07, 0.3, 0.76))], 0.007, M['metal'])
    for y in (0.3, 0.45, 0.6, 0.75):
        f.cyl(V((-0.07, y, 0.77)), V((0.07, y, 0.77)), 0.005, M['metal'], seg=6)
    for x in (-0.07, 0.07):
        f.cyl(V((x, 0.3, 0.77)), V((x, 0.82, 0.77)), 0.006, M['metal'], seg=6)
    f.cyl(ST, SEAT, 0.014, M['metal'])
    saddle(f, M, SEAT, 'comfort')
    f.box(V((-0.06, (BB.y + RA.y) / 2, 0.33)), (0.03, 0.56, 0.11), M['dark'])          # chain guard
    fender(f, M, R + 0.025, 1.1, 3.2, 0.05, c=RA)
    f.box(V((0, 0.82, 0.62)), (0.06, 0.004, 0.03), M['reflector'])
    frame = f.to_object(coll)

    fk = Part('fork')
    off = -HT_TOP
    for s in (-1, 1):
        fk.tube([HT_BOT + off + V((s * 0.03, 0, 0)), V((s * 0.045, -0.45, 0.55)) + off, FA + off + V((s * 0.045, 0, 0))], 0.012, M['paint'])
    fk.cyl(V((0, 0, 0.0)), V((0, -0.01, 0.09)), 0.016, M['metal'])                 # stem
    grips = handlebar(fk, M, V((0, -0.01, 0.1)), 'swept', 0.6)
    fender(fk, M, R + 0.025, 0.25, 1.9, 0.05, c=FA + off)
    # front carrier and wire basket above the front wheel
    for s in (-1, 1):
        fk.tube([FA + off + V((s * 0.05, 0, 0)), V((s * 0.09, -0.6, 0.855)) + off], 0.006, M['metal'], seg=6)
    fk.tube([V((0, -0.37, 0.86)) + off, V((0, -0.45, 0.855)) + off], 0.008, M['metal'], seg=6)   # bracket to the head tube
    fk.tube([V((0, -0.71, 0.86)) + off, V((0, -0.74, 0.81)) + off], 0.005, M['metal'], seg=6)    # lamp bracket
    c = V((0, -0.59, 0.86)) + off
    w, d, h = 0.34, 0.28, 0.2
    for z in (0, h * 0.5, h):
        ring = [c + V((-w / 2, -d / 2, z)), c + V((w / 2, -d / 2, z)), c + V((w / 2, d / 2, z)), c + V((-w / 2, d / 2, z)), c + V((-w / 2, -d / 2, z))]
        fk.tube(ring, 0.005, M['basket'], seg=5, caps=False)
    for i in range(6):
        x = -w / 2 + w * i / 5
        for y in (-d / 2, d / 2):
            fk.cyl(c + V((x, y, 0)), c + V((x, y, h)), 0.003, M['basket'], seg=4, caps=False)
    for i in range(5):
        y = -d / 2 + d * i / 4
        for x in (-w / 2, w / 2):
            fk.cyl(c + V((x, y, 0)), c + V((x, y, h)), 0.003, M['basket'], seg=4, caps=False)
    fk.box(c + V((0, 0, 0.002)), (w, d, 0.004), M['basket'])
    fork = fk.to_object(coll, frame, HT_TOP)

    wf = Part('wheel_front')
    wheel(wf, M, R, tyre_w=0.042, spokes=36)
    wf.cyl(V((-0.05, 0, 0)), V((0.05, 0, 0)), 0.035, M['metal'], seg=14)   # hub dynamo
    wheel_front = wf.to_object(coll, fork, FA)
    wr = Part('wheel_rear')
    wheel(wr, M, R, tyre_w=0.042, spokes=36)
    wr.cyl(V((-0.04, 0, 0)), V((0.04, 0, 0)), 0.04, M['metal'], seg=16)    # hub gear
    wr.to_object(coll, frame, RA)

    cp = Part('crank')
    pl, pr = crankset(cp, M, ring_r=0.1)
    crank = cp.to_object(coll, frame, BB)
    for name, p in (('pedal_l', pl), ('pedal_r', pr)):
        pp = Part(name)
        pedal(pp, M)
        pp.to_object(coll, crank, BB + p)

    lf = Part('light_front')
    lamp(lf, M, 'front')
    lf.to_object(coll, fork, V((0, -0.76, 0.80)))
    lr = Part('light_rear')
    lamp(lr, M, 'rear')
    lr.to_object(coll, frame, V((0, 0.83, 0.72)))

    empty(coll, 'seat', SEAT + V((0, 0.03, 0.06)), frame)
    empty(coll, 'grip_l', HT_TOP + V((0, -0.01, 0.1)) + grips[0], fork)
    empty(coll, 'grip_r', HT_TOP + V((0, -0.01, 0.1)) + grips[1], fork)
    return frame


result = run(NAME, HERE, build, (1.7, 1.95))
