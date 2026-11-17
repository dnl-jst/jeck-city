"""E-Scooter (shared rental scooter: thick raked stem, wide deck with the battery inside, 10" tyres, fenders, display,
phone holder, insurance plate): procedural model. No crank: pedal_l / pedal_r are where the feet stand on the deck
(left front, right behind), `seat` is the standing rider's hip point. Material `paint` is the fleet colour.

Run inside Blender (MCP): exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/escooter/build.py
Conventions: ../README.md.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import (Matrix, Part, V, bike_materials, clear_default_scene, empty, lamp, reset_collection,  # noqa: E402
                       run)
from nnmodel import material  # noqa: E402

NAME = 'escooter'
R = 0.13                         # 10" pneumatic
TW = 0.06                        # tyre width
FA = V((0, -0.43, R))            # front axle
RA = V((0, 0.43, R))             # rear axle
DECK_Y = (-0.30, 0.31)           # deck from / to (front, rear)
DECK_Z = (0.075, 0.155)          # underside / top
DECK_W = 0.19
HEAD = V((0, -0.395, 0.30))      # fork pivot: bottom of the steering tube
BAR = V((0, -0.30, 1.08))        # handlebar centre (stem top)
BAR_HW = 0.27                    # half width of the bar


def rim_wheel(part, M, radius):
    """Small-wheel: fat tyre, solid dark rim with 5 spokes, motor/drum hub (about X)."""
    tr = TW / 2
    part.torus_x((0, 0, 0), radius - tr, tr, M['tyre'], seg=40, rseg=10, squash=1.0)
    rim_r = radius - TW * 0.9
    part.torus_x((0, 0, 0), rim_r, 0.012, M['dark'], seg=32, rseg=6, squash=1.6)
    part.cyl((-0.045, 0, 0), (0.045, 0, 0), 0.042, M['dark'], seg=20)
    part.cyl((-0.047, 0, 0), (0.047, 0, 0), 0.016, M['metal'], seg=10)
    for i in range(5):
        a = 2 * math.pi * i / 5
        d = V((0, math.cos(a), math.sin(a)))
        part.box(d * (rim_r + 0.042) / 2, (0.02, 0.022, rim_r - 0.04), M['dark'], rot=Matrix.Rotation(a - math.pi / 2, 3, 'X'))


def fender_strip(part, mat, pts, centre, half_w, thick=0.004):
    """Mudguard: a curved strip through pts (around `centre`, the axle), half_w wide in X, `thick` thick (a closed shell)."""
    rows = []
    for p in pts:
        out = (p - centre).normalized()
        ring = [p + V((half_w, 0, 0)), p + V((-half_w, 0, 0)), p + V((-half_w, 0, 0)) - out * thick, p + V((half_w, 0, 0)) - out * thick]
        rows.append([part.bm.verts.new(v) for v in ring])
    for a, b in zip(rows, rows[1:]):
        for k in range(4):
            part._face([a[k], b[k], b[(k + 1) % 4], a[(k + 1) % 4]], mat, smooth=False)
    part._face(rows[0][::-1], mat, smooth=False)
    part._face(rows[-1], mat, smooth=False)


def build():
    clear_default_scene()
    coll = reset_collection('BIKE_ESCOOTER')
    M = bike_materials()
    M['paint'] = material('paint', (0.16, 0.62, 0.36), rough=0.4, metal=0.15)    # fleet colour (recoloured per scooter)
    M['trim'] = material('trim', (0.86, 0.87, 0.86), rough=0.45)                   # light grey plastic covers
    M['grip_tape'] = material('grip_tape', (0.05, 0.05, 0.055), rough=0.95)
    M['screen'] = material('screen', (0.04, 0.07, 0.09), rough=0.15, metal=0.2)
    M['plate'] = material('plate', (0.93, 0.93, 0.9), rough=0.5)
    M['plate_ink'] = material('plate_ink', (0.05, 0.05, 0.06), rough=0.6)
    M['plate_mark'] = material('plate_mark', (0.15, 0.32, 0.72), rough=0.5)       # insurance-year colour (blue)

    # ------------------------------------------------------------ frame: deck, neck, rear fender, lamps, plate
    f = Part('frame')
    y0, y1 = DECK_Y
    zb, zt = DECK_Z
    mid = V((0, (y0 + y1) / 2, (zb + zt) / 2))
    f.box(mid, (DECK_W, y1 - y0, zt - zb - 0.012), M['paint'])                       # deck shell (battery inside)
    f.box(mid + V((0, 0, (zt - zb) / 2 - 0.004)), (DECK_W - 0.02, y1 - y0 - 0.03, 0.01), M['grip_tape'])
    f.box(mid + V((0, 0, -(zt - zb) / 2 + 0.002)), (DECK_W - 0.03, y1 - y0 - 0.06, 0.008), M['dark'])  # underside cover
    for s in (-1, 1):                                                                # trim strips along the deck sides
        f.box(V((s * (DECK_W / 2 + 0.002), mid.y, zt - 0.03)), (0.006, y1 - y0 - 0.04, 0.022), M['trim'])
    # neck: from the deck front up to the steering tube
    f.tube([V((0, y0 + 0.04, zt - 0.03)), V((0, y0 - 0.04, zt + 0.02)), HEAD + V((0, 0.015, -0.03))], 0.034, M['paint'], seg=14)
    f.cyl(HEAD + V((0, 0, -0.05)), HEAD + V((0, 0, 0.04)), 0.036, M['dark'], seg=14)  # head bearing housing
    # rear: deck tail, dropouts, fender over the wheel
    f.box(V((0, y1 + 0.03, zt - 0.03)), (DECK_W - 0.04, 0.06, 0.05), M['paint'])
    for s in (-1, 1):
        f.box(V((s * 0.05, (y1 + RA.y) / 2 + 0.01, (zt + RA.z) / 2 - 0.01)), (0.012, RA.y - y1 + 0.06, 0.05), M['dark'])
    fp = []
    for i in range(9):
        a = math.radians(35 + 130 * i / 8)                                           # from the deck over the top to the back
        fp.append(RA + V((0, -math.cos(a) * (R + 0.022), math.sin(a) * (R + 0.022))))
    fender_strip(f, M['paint'], fp, RA, TW / 2 + 0.012)
    # insurance plate (Versicherungskennzeichen) under the rear light, facing back (+Y)
    pz, py = 0.115, RA.y + R + 0.03
    f.box(V((0, py - 0.008, pz + 0.06)), (0.03, 0.012, 0.04), M['dark'])             # bracket under the fender tail
    f.box(V((0, py, pz)), (0.13, 0.004, 0.095), M['plate'])
    f.box(V((0, py + 0.0025, pz + 0.035)), (0.13, 0.002, 0.022), M['plate_mark'])
    for k, w in enumerate((0.022, 0.022, 0.022, 0.016, 0.016, 0.016)):               # two rows of characters
        row, col = divmod(k, 3)
        f.box(V((-0.035 + col * 0.035, py + 0.0025, pz + 0.004 - row * 0.032)), (w, 0.002, 0.022), M['plate_ink'])
    # side reflectors on the deck
    for s in (-1, 1):
        f.box(V((s * (DECK_W / 2 + 0.006), y1 - 0.06, zt - 0.03)), (0.004, 0.05, 0.016), M['reflector'])
    frame = f.to_object(coll)

    # ------------------------------------------------------------ fork: stem, bar, display, fork legs, front fender
    fk = Part('fork')
    o = -HEAD
    top = BAR + V((0, 0, -0.03))
    s0 = HEAD + o + V((0, 0, 0.03))
    ax = (top + o - s0).normalized()                                                 # stem axis (raked back)
    fk.tube([s0, top + o], 0.03, M['paint'], seg=16)                                 # stem
    fk.cyl(s0 + ax * 0.02, s0 + ax * 0.42, 0.036, M['trim'], seg=16)                # lower stem cover
    fold = s0 + ax * 0.1
    fk.box(fold + V((0, -0.01, 0)), (0.07, 0.06, 0.07), M['dark'])                   # folding clamp
    # QR panel on the stem (towards the rider)
    q = s0 + ax * 0.55
    tilt = Matrix.Rotation(math.atan2(ax.y, ax.z), 3, 'X')                           # panels lie on the raked stem
    back = tilt @ V((0, 1, 0))
    fk.box(q + back * 0.032, (0.06, 0.006, 0.08), M['trim'], rot=tilt)
    for i in range(3):
        for j in range(3):
            if (i + j) % 2 == 0 or (i, j) == (1, 1):
                fk.box(q + back * 0.0355 + tilt @ V((-0.018 + i * 0.018, 0, -0.018 + j * 0.018)), (0.013, 0.001, 0.013), M['plate_ink'], rot=tilt)
    # handlebar with grips, brake levers, bell, display, phone holder
    b = BAR + o
    fk.tube([b + V((-BAR_HW, 0.01, 0)), b + V((-0.06, 0, 0)), b + V((0.06, 0, 0)), b + V((BAR_HW, 0.01, 0))], 0.013, M['dark'], seg=10)
    grips = []
    for s in (-1, 1):
        g = b + V((s * (BAR_HW - 0.055), 0.01, 0))
        fk.cyl(g - V((s * 0.055, 0, 0)), g + V((s * 0.058, 0, 0)), 0.018, M['rubber'], seg=12)
        fk.tube([b + V((s * 0.13, -0.01, 0.01)), b + V((s * 0.19, 0.06, 0.0)), b + V((s * 0.21, 0.07, -0.01))], 0.005, M['metal'], seg=6)  # lever
        grips.append(HEAD + g)
    fk.box(b + V((0, 0.0, 0.035)), (0.11, 0.07, 0.03), M['dark'])                    # display housing
    fk.box(b + V((0, 0.012, 0.051)), (0.085, 0.045, 0.003), M['screen'])
    fk.cyl(b + V((0.08, 0, 0.0)), b + V((0.08, 0, 0.03)), 0.017, M['metal'], seg=12)  # bell
    fk.box(b + V((-0.1, 0.02, 0.03)), (0.075, 0.13, 0.01), M['dark'], rot=Matrix.Rotation(0.6, 3, 'X'))  # phone holder
    # fork legs (two, short, with a suspension can) down to the axle
    a = FA + o
    for s in (-1, 1):
        fk.tube([V((s * 0.04, 0, -0.02)), V((s * 0.045, -0.02, -0.08)), a + V((s * 0.045, 0, 0))], 0.014, M['dark'], seg=8)
    fk.cyl(V((0, 0, -0.02)), V((0, 0, -0.06)), 0.03, M['metal'], seg=12)
    ffp = []
    for i in range(7):
        ang = math.radians(25 + 90 * i / 6)
        ffp.append(a + V((0, -math.cos(ang) * (R + 0.02), math.sin(ang) * (R + 0.02))))
    fender_strip(fk, M['paint'], ffp, a, TW / 2 + 0.01)
    fork = fk.to_object(coll, frame, HEAD)

    wf = Part('wheel_front')
    rim_wheel(wf, M, R)
    wf.to_object(coll, fork, FA)
    wr = Part('wheel_rear')
    rim_wheel(wr, M, R)
    wr.disc_x((-0.05, 0, 0), 0.05, 0.004, M['metal'], seg=20)                        # brake disc
    wr.to_object(coll, frame, RA)

    lf = Part('light_front')
    lamp(lf, M, 'front')
    lf.to_object(coll, fork, HEAD + (BAR - HEAD) * 0.52 + V((0, -0.035, 0)))
    lr = Part('light_rear')
    lamp(lr, M, 'rear')
    ang = math.radians(138)                                                          # on the fender, facing back
    lr.to_object(coll, frame, RA + V((0, -math.cos(ang) * (R + 0.04), math.sin(ang) * (R + 0.04))))

    # rider: feet on the deck (left just ahead of the middle, right at the tail), hips behind the middle, knees soft
    # (the client's leg IK rolls the legs inwards, so the feet stand close to the centre line)
    empty(coll, 'pedal_l', V((0.03, -0.07, zt + 0.02)), frame)
    empty(coll, 'pedal_r', V((-0.035, 0.21, zt + 0.02)), frame)
    empty(coll, 'seat', V((0, 0.09, zt + 0.86)), frame)
    empty(coll, 'grip_l', grips[1], fork)
    empty(coll, 'grip_r', grips[0], fork)
    return frame


result = run(NAME, HERE, build, (1.0, 1.3), crank=False)
