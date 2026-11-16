"""Long John (two-wheeled cargo bike, flat wooden deck between the rider and a small front wheel): procedural bike model.

Run inside Blender (e.g. via the Blender MCP add-on):
    exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/longjohn/build.py
It rebuilds the collection BIKE_LONGJOHN, saves longjohn.blend and exports longjohn.glb next to this file.
Conventions: ../README.md (origin on the ground between the wheel contacts, bike faces -Y, node names).
"""
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import (Matrix, Part, V, bike_materials, clear_default_scene, crankset, empty, fender, handlebar,  # noqa: E402
                       lamp, pedal, reset_collection, run, saddle, wheel)

NAME = 'longjohn'

# key points (m): front axle at -Y
RA = V((0, 0.975, 0.33))     # rear axle, 26"
FA = V((0, -0.975, 0.25))    # front axle, 20"
BB = V((0, 0.52, 0.28))      # bottom bracket
ST = V((0, 0.655, 0.80))     # seat tube top
SEAT = V((0, 0.70, 0.93))    # saddle clamp
HT_TOP = V((0, -0.76, 0.56))  # head tube top = fork pivot
HT_BOT = V((0, -0.72, 0.37))
BAR = V((0, 0.33, 0.88))     # handlebar column top = bar pivot
DECK = dict(y0=-0.66, y1=0.2, x=0.29, z=0.35, rail=0.12)


def build(coll_name='BIKE_LONGJOHN', cargo=None):
    """cargo(part, M, deck): optional load added to the frame on the deck (see ../soundjohn)."""
    clear_default_scene()
    coll = reset_collection(coll_name)
    M = bike_materials()

    # ---- frame (root)
    f = Part('frame')
    r = 0.022
    f.tube([BB, V((0, 0.30, 0.30)), V((0, -0.62, 0.30)), HT_BOT], 0.03, M['paint'])            # main beam under the box
    f.tube([HT_BOT, HT_TOP], 0.025, M['paint'])                                               # head tube
    f.tube([BB, ST], r, M['paint'])                                                           # seat tube
    f.tube([ST + V((0, -0.01, -0.05)), V((0, 0.34, 0.80))], r, M['paint'])                     # top tube to the column
    f.tube([V((0, 0.28, 0.31)), V((0, 0.34, 0.80)), BAR - V((0, 0, 0.02))], 0.024, M['paint'])  # handlebar column
    for s in (-1, 1):
        f.tube([BB + V((s * 0.03, 0, 0)), RA + V((s * 0.065, 0, 0))], 0.012, M['paint'])                     # chainstays
        f.tube([ST + V((s * 0.02, -0.01, -0.07)), RA + V((s * 0.065, 0, 0))], 0.011, M['paint'])             # seatstays
        f.tube([RA + V((s * 0.07, 0, 0)), V((s * 0.07, 0.86, 0.72)), V((s * 0.07, 0.68, 0.72))], 0.008, M['metal'])  # rack struts
    for y in (0.66, 0.8, 0.95, 1.1):
        f.cyl(V((-0.075, y, 0.725)), V((0.075, y, 0.725)), 0.006, M['metal'], seg=6)
    f.tube([V((-0.075, 0.66, 0.725)), V((-0.075, 1.16, 0.725))], 0.007, M['metal'], seg=6)
    f.tube([V((0.075, 0.66, 0.725)), V((0.075, 1.16, 0.725))], 0.007, M['metal'], seg=6)
    f.cyl(ST, SEAT, 0.014, M['metal'])                                                        # seat post
    saddle(f, M, SEAT, 'comfort')
    # battery on the seat tube
    st_dir = (ST - BB).normalized()
    rot = Matrix.Rotation(math.atan2(st_dir.y, st_dir.z), 3, 'X')
    f.box(BB + st_dir * 0.28 + V((0, -0.05, 0)), (0.08, 0.06, 0.32), M['dark'], rot=rot)
    # flat cargo deck: wooden slats on cross members, a low tube rail around it
    d = DECK
    yc, ly = (d['y0'] + d['y1']) / 2, d['y1'] - d['y0']
    for k in range(-2, 3):  # cross members under the deck
        f.cyl(V((-d['x'] + 0.02, yc + k * ly / 5, d['z'] - 0.03)), V((d['x'] - 0.02, yc + k * ly / 5, d['z'] - 0.03)), 0.012, M['paint'], seg=8)
    n = 7
    for k in range(n):  # slats along the bike with small gaps
        x = -d['x'] + (2 * d['x']) * (k + 0.5) / n
        f.box((x, yc, d['z']), (2 * d['x'] / n - 0.012, ly, 0.022), M['wood'])
    rail = [V((-d['x'], d['y1'], d['z'] + 0.01)), V((-d['x'], d['y0'] + 0.04, d['z'] + 0.01)),
            V((-d['x'] + 0.04, d['y0'], d['z'] + 0.01)), V((d['x'] - 0.04, d['y0'], d['z'] + 0.01)),
            V((d['x'], d['y0'] + 0.04, d['z'] + 0.01)), V((d['x'], d['y1'], d['z'] + 0.01))]
    raised = [p + V((0, 0, d['rail'])) for p in rail]
    f.tube(raised, 0.011, M['paint'], seg=8)
    for p, q in zip(rail[::2] + [rail[-1]], raised[::2] + [raised[-1]]):
        f.cyl(p, q, 0.01, M['paint'], seg=8)
    f.box((0, d['y0'] - 0.012, d['z'] + 0.02), (0.12, 0.004, 0.03), M['reflector'])
    # steering rod from the column to the fork, chain
    f.tube([V((0.06, 0.28, 0.30)), V((0.06, -0.62, 0.30)), V((0.05, -0.70, 0.38))], 0.006, M['metal'], seg=6)  # under the deck
    for z0, z1 in ((0.38, 0.37), (0.18, 0.29)):
        f.cyl(V((-0.05, BB.y, z0)), V((-0.05, RA.y, z1)), 0.004, M['dark'], seg=4, caps=False)
    fender(f, M, 0.36, 1.25, 3.0, 0.055, c=RA)   # rear mudguard (on the frame: the wheel spins)
    if cargo:
        cargo(f, M, DECK)
    frame = f.to_object(coll)

    # ---- fork (pivot on the steering axis) with the front wheel
    fk = Part('fork')
    for s in (-1, 1):
        fk.tube([HT_BOT - HT_TOP + V((s * 0.045, -0.01, 0)), FA - HT_TOP + V((s * 0.045, 0, 0))], 0.013, M['paint'])
    fk.cyl(V((0, 0, 0.02)), HT_BOT - HT_TOP + V((0, 0, 0.02)), 0.016, M['dark'])
    fk.cyl(V((-0.05, -0.0, -0.17)), V((0.05, -0.0, -0.17)), 0.014, M['paint'])   # crown
    fender(fk, M, 0.275, 0.35, 1.9, 0.045, c=FA - HT_TOP)
    fork = fk.to_object(coll, frame, HT_TOP)

    wf = Part('wheel_front')
    wheel(wf, M, 0.25, tyre_w=0.05, spokes=28)
    wheel_front = wf.to_object(coll, fork, FA)

    wr = Part('wheel_rear')
    wheel(wr, M, 0.33, tyre_w=0.05, spokes=32)
    wr.disc_x((-0.05, 0, 0), 0.04, 0.005, M['dark'], seg=16)   # sprocket
    wheel_rear = wr.to_object(coll, frame, RA)

    # ---- handlebar (turns with the steering)
    bp = Part('bar')
    bp.cyl(V((0, 0, -0.04)), V((0, -0.03, 0.08)), 0.016, M['dark'])
    grips = handlebar(bp, M, V((0, -0.03, 0.09)), 'riser', 0.62)
    bar = bp.to_object(coll, frame, BAR)

    # ---- crank and pedals
    cp = Part('crank')
    pl, pr = crankset(cp, M, ring_r=0.1)
    crank = cp.to_object(coll, frame, BB)
    for name, p in (('pedal_l', pl), ('pedal_r', pr)):
        pp = Part(name)
        pedal(pp, M)
        pp.to_object(coll, crank, BB + p)

    # ---- lights
    lf = Part('light_front')
    lamp(lf, M, 'front')
    lf.to_object(coll, fork, HT_TOP + V((0, -0.05, 0.02)))  # on the head tube, turns with the fork
    lr = Part('light_rear')
    lamp(lr, M, 'rear')
    lr.to_object(coll, frame, V((0, 1.175, 0.71)))

    # ---- rider attachment points
    empty(coll, 'seat', SEAT + V((0, 0.03, 0.06)), frame)
    empty(coll, 'grip_l', BAR + grips[0], bar)
    empty(coll, 'grip_r', BAR + grips[1], bar)
    return frame


if not globals().get('NN_IMPORT_ONLY'):  # soundjohn/build.py reuses build()
    result = run(NAME, HERE, build, (2.3, 2.7))
