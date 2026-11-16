"""Sound Long John: the Long John (../longjohn) with a big party sound box strapped onto its cargo deck.

Run inside Blender (e.g. via the Blender MCP add-on):
    exec(open(PATH).read(), {'__file__': PATH})
or headless:  blender -b --factory-startup --python data/models/bikes/soundjohn/build.py
It rebuilds the collection BIKE_SOUNDJOHN, saves soundjohn.blend and exports soundjohn.glb next to this file.
Same frame, nodes and rider points as the Long John; only the deck carries the box (part of the `frame` node).
"""
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
from bikeparts import Part, V, run  # noqa: E402
from nnmodel import material  # noqa: E402

NAME = 'soundjohn'

_LJ = os.path.join(HERE, '..', 'longjohn', 'build.py')
_lj = {'__file__': _LJ, 'NN_IMPORT_ONLY': True}
exec(open(_LJ).read(), _lj)

# the box (m): inside the deck rail, from just behind the front rail to the handlebar column
BOX = dict(x=0.26, y0=-0.62, y1=-0.06, z0=0.362, z1=0.90)
# disco ball on a pole over the front of the box: centre (node `disco`, spins about the vertical) and radius
DISCO = V((0, -0.5, 1.40))
DISCO_R = 0.1


def emissive(name, color, strength):
    m = material(name, color, rough=0.3)
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Emission Color'].default_value = bsdf.inputs['Base Color'].default_value
    bsdf.inputs['Emission Strength'].default_value = strength
    return m


def lathe_y(part, cx, cz, profile, seg=28):
    """Closed surface of revolution about the Y axis through (cx, cz): profile = [(r, y, mat of the band to the next point)].
    Both ends are capped, so the normals come out right."""
    rings = []
    for r, y, _ in profile:
        rings.append([part.bm.verts.new(V((cx + r * math.cos(2 * math.pi * k / seg), y, cz + r * math.sin(2 * math.pi * k / seg))))
                      for k in range(seg)])
    for (a, b), (_, _, mat) in zip(zip(rings, rings[1:]), profile):
        for k in range(seg):
            part._face([a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]], mat)
    part._face(list(reversed(rings[0])), profile[0][2], smooth=False)
    part._face(rings[-1], profile[-2][2], smooth=False)


def sound_box(f, M, deck):
    b = BOX
    cab = material('cabinet', (0.045, 0.045, 0.05), rough=0.75)
    cone = material('cone', (0.09, 0.09, 0.1), rough=0.85)
    trim = material('trim', (0.16, 0.16, 0.17), rough=0.5, metal=0.4)
    strap = material('strap', (0.85, 0.42, 0.05), rough=0.8)
    hole = material('port', (0.01, 0.01, 0.01), rough=1.0)
    led = emissive('led', (0.1, 0.75, 1.0), 2.5)
    display = emissive('display', (0.25, 0.55, 1.0), 1.5)
    chrome, rubber = M['metal'], M['rubber']

    w, d, h = 2 * b['x'], b['y1'] - b['y0'], b['z1'] - b['z0']
    yc, zc = (b['y0'] + b['y1']) / 2, (b['z0'] + b['z1']) / 2
    f.box((0, yc, zc), (w, d, h), cab)
    # corner protectors
    for sx in (-1, 1):
        for sy in (b['y0'], b['y1']):
            for sz in (b['z0'], b['z1']):
                f.box((sx * (b['x'] - 0.012), sy + (0.012 if sy == b['y0'] else -0.012), sz + (0.012 if sz == b['z0'] else -0.012)),
                      (0.05, 0.05, 0.05), trim)

    yf = b['y0']  # front baffle (faces forward, -Y)
    # two 8" woofers: chrome bezel, rubber surround, paper cone dished inwards, dust cap
    for x in (-0.125, 0.125):
        lathe_y(f, x, 0.575, [(0.105, yf + 0.001, chrome), (0.105, yf - 0.008, chrome), (0.094, yf - 0.008, rubber),
                              (0.087, yf - 0.019, rubber), (0.078, yf - 0.010, cone), (0.034, yf - 0.002, cone),
                              (0.034, yf - 0.003, cone), (0.022, yf - 0.014, cone), (0.002, yf - 0.017, cone)])
    # two horn tweeters
    for x in (-0.125, 0.125):
        lathe_y(f, x, 0.795, [(0.05, yf + 0.001, chrome), (0.05, yf - 0.006, chrome), (0.036, yf - 0.006, cab),
                              (0.03, yf - 0.002, cab), (0.02, yf - 0.002, chrome), (0.012, yf - 0.012, chrome), (0.002, yf - 0.014, chrome)])
    f.box((0, yf - 0.002, 0.42), (0.30, 0.006, 0.04), hole)   # bass port slot
    f.box((0, yf - 0.002, 0.795), (0.09, 0.004, 0.025), chrome)  # badge between the tweeters
    # LED strips round the front and down the sides (always on: it's a party box)
    f.box((0, yf - 0.003, b['z0'] + 0.022), (w - 0.06, 0.006, 0.01), led)
    for sx in (-1, 1):
        f.box((sx * (b['x'] + 0.002), yc, b['z0'] + 0.022), (0.006, d - 0.06, 0.01), led)
    # back panel towards the rider: display, volume knobs, power LED
    yb = b['y1']
    f.box((0, yb + 0.003, 0.8), (0.32, 0.006, 0.1), trim)
    f.box((-0.07, yb + 0.007, 0.805), (0.12, 0.004, 0.045), display)
    for x in (0.05, 0.11):
        f.cyl(V((x, yb + 0.004, 0.805)), V((x, yb + 0.03, 0.805)), 0.018, chrome, seg=16)
    f.box((0.14, yb + 0.007, 0.77), (0.012, 0.004, 0.012), led)
    # carrying handle on top
    f.tube([V((-0.12, yc, b['z1'] - 0.005)), V((-0.12, yc, b['z1'] + 0.045)), V((0.12, yc, b['z1'] + 0.045)), V((0.12, yc, b['z1'] - 0.005))],
           0.013, rubber, seg=8)
    # two ratchet straps over the box down to the deck rail
    for ys in (b['y0'] + 0.12, b['y1'] - 0.12):
        f.box((0, ys, b['z1'] + 0.003), (w + 0.014, 0.035, 0.006), strap)
        for sx in (-1, 1):
            f.box((sx * (b['x'] + 0.007), ys, zc + 0.003), (0.006, 0.035, h + 0.012), strap)
            f.box((sx * (b['x'] + 0.012), ys, zc - 0.05), (0.012, 0.045, 0.06), chrome)  # ratchet buckle
    # disco ball pole with its little motor
    f.cyl(V((0, DISCO.y, b['z1'] - 0.01)), V((0, DISCO.y, DISCO.z - DISCO_R - 0.03)), 0.012, chrome, seg=10)
    f.cyl(V((0, DISCO.y, DISCO.z - DISCO_R - 0.035)), V((0, DISCO.y, DISCO.z - DISCO_R + 0.005)), 0.028, trim, seg=16)


def disco_ball(coll, frame):
    """Faceted mirror ball (flat-shaded mirror tiles), its own node so the client can spin it."""
    p = Part('disco')
    mirror = material('mirror', (0.86, 0.87, 0.9), rough=0.12, metal=1.0)
    rows, cols = 14, 28
    ring = []
    for i in range(1, rows):
        th = math.pi * i / rows
        ring.append([p.bm.verts.new(V((DISCO_R * math.sin(th) * math.cos(2 * math.pi * k / cols), DISCO_R * math.sin(th) * math.sin(2 * math.pi * k / cols),
                                         DISCO_R * math.cos(th)))) for k in range(cols)])
    top, bottom = p.bm.verts.new(V((0, 0, DISCO_R))), p.bm.verts.new(V((0, 0, -DISCO_R)))
    for k in range(cols):
        k1 = (k + 1) % cols
        p._face([top, ring[0][k], ring[0][k1]], mirror, smooth=False)
        p._face([bottom, ring[-1][k1], ring[-1][k]], mirror, smooth=False)
        for a, b in zip(ring, ring[1:]):
            p._face([a[k], b[k], b[k1], a[k1]], mirror, smooth=False)
    p.to_object(coll, frame, DISCO)


def build():
    frame = _lj['build']('BIKE_SOUNDJOHN', sound_box)
    disco_ball(bpy.data.collections['BIKE_SOUNDJOHN'], frame)
    return frame


result = run(NAME, HERE, build, (2.3, 2.7))
