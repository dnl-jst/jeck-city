"""Dreirad-Lastenrad (cargo trike: wooden box on two 20" front wheels, the whole box steers about a kingpin behind
it, wide handlebar fixed to the box, 26" rear wheel): procedural bike model.

Run inside Blender (MCP): exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/trike/build.py
Conventions: ../README.md (trike: wheel_front_l / wheel_front_r on the fork node).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import (Part, V, bike_materials, clear_default_scene, crankset, empty, fender, lamp,  # noqa: E402
                       pedal, reset_collection, run, saddle, wheel)

NAME = 'trike'
RR = 0.33                         # 26" rear
RF = 0.25                         # 20" front
RA = V((0, 0.8, RR))
FA_Y = -0.8
TRACK = 0.4                       # front wheels at x = ±TRACK
BB = V((0, 0.36, 0.29))
ST = V((0, 0.5, 0.80))
SEAT = V((0, 0.55, 0.94))
KING = V((0, -0.32, 0.42))        # kingpin: the box turns about this vertical axis
BOX = dict(y0=-1.12, y1=-0.38, x=0.33, floor=0.34, top=0.82)


def build():
    clear_default_scene()
    coll = reset_collection('BIKE_TRIKE')
    M = bike_materials()

    f = Part('frame')
    f.tube([BB, V((0, 0.0, 0.32)), KING + V((0, 0.0, -0.06))], 0.03, M['paint'])
    f.cyl(KING + V((0, 0, -0.08)), KING + V((0, 0, 0.06)), 0.035, M['dark'])        # kingpin bearing
    f.tube([BB, ST], 0.022, M['paint'])
    f.tube([ST + V((0, -0.01, -0.05)), V((0, 0.05, 0.62)), V((0, -0.08, 0.36))], 0.022, M['paint'])
    for s in (-1, 1):
        f.tube([BB + V((s * 0.03, 0, 0)), RA + V((s * 0.065, 0, 0))], 0.012, M['paint'])
        f.tube([ST + V((s * 0.02, -0.01, -0.07)), RA + V((s * 0.065, 0, 0))], 0.011, M['paint'])
    f.cyl(ST, SEAT, 0.015, M['metal'])
    saddle(f, M, SEAT, 'comfort')
    f.box(V((0, 0.42, 0.52)), (0.08, 0.06, 0.28), M['dark'])                        # battery
    for z0, z1 in ((0.38, 0.37), (0.18, 0.29)):
        f.cyl(V((-0.05, BB.y, z0)), V((-0.05, RA.y, z1)), 0.004, M['dark'], seg=4, caps=False)
    fender(f, M, RR + 0.025, 1.2, 3.1, 0.055, c=RA)
    frame = f.to_object(coll)

    # ---- the steering unit: box, front axle, handlebar (pivot = kingpin)
    k = Part('fork')
    off = -KING
    b = BOX
    yc, ly = (b['y0'] + b['y1']) / 2, b['y1'] - b['y0']
    h = b['top'] - b['floor']
    zc = b['floor'] + h / 2
    k.box(V((0, yc, b['floor'])) + off, (2 * b['x'], ly, 0.02), M['wood'])
    for s in (-1, 1):
        k.box(V((s * (b['x'] - 0.009), yc, zc)) + off, (0.018, ly, h), M['wood'])
    k.box(V((0, b['y0'] + 0.009, zc)) + off, (2 * b['x'], 0.018, h), M['wood'])
    k.box(V((0, b['y1'] - 0.009, zc)) + off, (2 * b['x'], 0.018, h), M['wood'])
    for s in (-1, 1):
        k.box(V((s * b['x'], yc, b['top'])) + off, (0.03, ly + 0.02, 0.02), M['dark'])
    for yy in (b['y0'], b['y1']):
        k.box(V((0, yy, b['top'])) + off, (2 * b['x'] + 0.02, 0.03, 0.02), M['dark'])
    for kk in (1, 2, 3):
        z = b['floor'] + h * kk / 4
        for s in (-1, 1):
            k.box(V((s * (b['x'] + 0.001), yc, z)) + off, (0.002, ly - 0.01, 0.006), M['wood_dark'])
        k.box(V((0, b['y0'] - 0.001, z)) + off, (2 * b['x'] - 0.01, 0.002, 0.006), M['wood_dark'])
    k.box(V((0, b['y0'] - 0.012, zc - 0.1)) + off, (0.12, 0.004, 0.03), M['reflector'])
    # front axle beam under the box and stub axles out to the wheels
    k.cyl(V((-TRACK + 0.04, FA_Y, RF)) + off, V((TRACK - 0.04, FA_Y, RF)) + off, 0.02, M['paint'])
    for s in (-1, 1):
        k.cyl(V((s * 0.2, FA_Y, RF)) + off, V((s * 0.2, FA_Y, b['floor'] - 0.01)) + off, 0.015, M['paint'])
        fender(k, M, RF + 0.025, 0.3, 2.2, 0.05, c=V((s * TRACK, FA_Y, RF)) + off)
    # box mount to the kingpin
    k.tube([V((0, b['y1'], b['floor'] - 0.02)) + off, V((0, -0.33, 0.36)) + off, V((0, 0, -0.06))], 0.025, M['paint'])
    # handlebar: a wide U from the box's back corners towards the rider
    grip_l = V((0.3, 0.12, 0.98))
    grip_r = V((-0.3, 0.12, 0.98))
    for s, g in ((1, grip_l), (-1, grip_r)):
        k.tube([V((s * (b['x'] - 0.03), b['y1'] + 0.01, b['top'] - 0.05)) + off, V((s * 0.31, -0.15, 0.93)) + off, g + off], 0.013, M['metal'], seg=8)
        k.cyl(g + off + V((0, -0.05, 0)), g + off + V((0, 0.07, 0.0)), 0.018, M['rubber'], seg=10)
    k.cyl(V((-0.31, -0.15, 0.93)) + off, V((0.31, -0.15, 0.93)) + off, 0.012, M['metal'], seg=8)
    fork = k.to_object(coll, frame, KING)

    for name, x in (('wheel_front_l', TRACK), ('wheel_front_r', -TRACK)):
        w = Part(name)
        wheel(w, M, RF, tyre_w=0.05, spokes=28)
        w.to_object(coll, fork, V((x, FA_Y, RF)))
    wr = Part('wheel_rear')
    wheel(wr, M, RR, tyre_w=0.05, spokes=32)
    wr.disc_x((-0.05, 0, 0), 0.04, 0.005, M['dark'], seg=16)
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
    lf.to_object(coll, fork, V((0, b['y0'] - 0.035, b['top'] - 0.12)))
    lr = Part('light_rear')
    lamp(lr, M, 'rear')
    lr.to_object(coll, frame, V((0, RA.y + RR + 0.03, RR + 0.12)))

    empty(coll, 'seat', SEAT + V((0, 0.03, 0.06)), frame)
    empty(coll, 'grip_l', grip_l, fork)
    empty(coll, 'grip_r', grip_r, fork)
    return frame


result = run(NAME, HERE, build, (2.0, 2.45), wheels=('wheel_front_l', 'wheel_front_r', 'wheel_rear'))
