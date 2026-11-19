"""Mittelklasse: four-door saloon (≈ 4.76 × 1.83 × 1.44 m, wheelbase 2.82 m, 225/45 R17).

Run headless:  blender -b --factory-startup --python data/models/cars/mittelklasse/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carparts import (plate_node, V, Part, build_body, car_materials, decal, decal_object, empty, exhaust, lamp_pair, mirror,  # noqa: E402
                      poly_round, rrect, run, wheel, wipers)

NAME = 'mittelklasse'
F, B = 2.31, -2.45

S = dict(
    wb=2.82, track=1.58, r=0.33, rim_r=0.225, tyre_w=0.225, spokes=5, double_spokes=False,
    front=F, rear=B,
    top=[(B, 0.98), (-2.40, 1.04), (-2.2, 1.06), (-1.88, 1.085), (-1.55, 1.27), (-1.15, 1.39), (-0.5, 1.435), (0.05, 1.42),
         (0.55, 1.17), (0.95, 0.965), (1.6, 0.875), (2.15, 0.78), (2.27, 0.725), (F, 0.66)],
    belt=[(B, 0.96), (-2.0, 0.985), (-1.0, 0.97), (0.95, 0.925), (1.6, 0.85), (2.2, 0.71), (F, 0.63)],
    bottom=[(B, 0.38), (-2.15, 0.25), (-1.4, 0.17), (1.4, 0.17), (2.05, 0.23), (F, 0.29)],
    width=[(B, 0.83), (-2.35, 0.89), (-2.1, 0.915), (1.9, 0.915), (2.15, 0.885), (2.27, 0.83), (F, 0.74)],
    topw=[(B, 0.78), (-2.0, 0.81), (-1.88, 0.78), (-1.15, 0.69), (0.05, 0.69), (0.95, 0.8), (1.6, 0.83), (2.15, 0.78), (F, 0.66)],
    widest=0.42,
    screen=(0.95, 0.05),
    topglass=[(0.93, 0.07), (-1.17, -1.86)],
    side=[(0.93, -0.12), (-0.22, -1.2), (-1.27, -1.5)],
    extra=[1.41, -1.41, 0.0],
    step=0.16,
)


def build(coll):
    M = car_materials((0.55, 0.56, 0.58))
    body = build_body(S, M, coll)
    d = Part('decals')
    head = poly_round([(-0.2, -0.04), (0.17, -0.045), (0.22, 0.01), (0.2, 0.045), (-0.2, 0.03)], 0.02)
    hl = lamp_pair(d, body, M, 'lamp_front', F, 0.6, 0.66, head, d_side=0.5)
    # grille: chrome frame, dark mesh, and a wide lower intake
    decal(d, body, M['chrome'], (0, -F, 0.6), (0, 1, 0), poly_round([(-0.33, -0.1), (0.33, -0.1), (0.36, 0.07), (-0.36, 0.07)], 0.03), bulge=0.004)
    decal(d, body, M['trim'], (0, -F, 0.6), (0, 1, 0), poly_round([(-0.31, -0.085), (0.31, -0.085), (0.34, 0.055), (-0.34, 0.055)], 0.025), off=0.008)
    decal(d, body, M['trim'], (0, -F, 0.36), (0, 1, 0), poly_round([(-0.62, -0.06), (0.62, -0.06), (0.56, 0.06), (-0.56, 0.06)], 0.04), bulge=0.003)
    decal(d, body, M['plate'], (0, -F, 0.46), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.012)
    decal(d, body, M['plate_eu'], (0.235, -F, 0.46), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.014)
    for s in (1, -1):
        decal(d, body, M['lamp_front'], (s * 0.66, -F, 0.38), (-s * 0.35, 1, 0), rrect(0.12, 0.035, 0.015), bulge=0.004)
    # rear: wide wrap-around tail lamps, chrome strip on the boot lid, plate
    tail = poly_round([(-0.2, -0.05), (0.22, -0.06), (0.24, 0.05), (-0.2, 0.05)], 0.02)
    tl = lamp_pair(d, body, M, 'lamp_rear', B, 0.6, 0.9, tail, d_side=0.6, front=False)
    decal(d, body, M['chrome'], (0, -B, 0.9), (0, -1, 0), rrect(0.6, 0.02, 0.008), off=0.004)
    decal(d, body, M['plate'], (0, -B, 0.75), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.008)
    decal(d, body, M['plate_eu'], (-0.235, -B, 0.75), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.01)
    decal(d, body, M['trim'], (0, -B, 0.34), (0, -1, 0), poly_round([(-0.8, -0.08), (0.8, -0.08), (0.78, 0.05), (-0.78, 0.05)], 0.04), off=0.003)
    for s in (1, -1):
        sd = V((-s, 0, 0))
        for u0, z0, z1 in ((1.1, 0.3, 0.93), (-0.17, 0.27, 0.97), (-1.24, 0.3, 0.98)):
            decal(d, body, M['dark'], (s, -u0, (z0 + z1) / 2), sd, rrect(0.008, z1 - z0, 0.003), off=0.0015)
        for u0 in (0.1, -1.05):
            decal(d, body, M['chrome'], (s, -u0, 0.86), sd, rrect(0.17, 0.03, 0.012), off=0.004, bulge=0.008)
        # chrome window line along the belt
        decal(d, body, M['chrome'], (s, 0.3, 0.955), sd, [(s * du, dz) for du, dz in ((-1.2, -0.012), (1.2, -0.03), (1.2, -0.016), (-1.2, 0.002))][::s], off=0.003)
        decal(d, body, M['indicator'], (s, -1.92, 0.76), sd, rrect(0.07, 0.022, 0.011), bulge=0.004)
    dec = decal_object(d, coll, body)

    p = Part('details')
    for s in (1, -1):
        mirror(p, M, (s * 0.87, -0.8, 0.98), s)
    wipers(p, M, body, S)
    for s in (1, -1):
        exhaust(p, M, body, s * 0.5, B, r=0.042)
    p.box(V((0, 0.9, 1.45)), (0.06, 0.16, 0.05), M['trim'])  # roof antenna fin
    det = p.to_object(coll)
    det.parent = body

    ua, x = S['wb'] / 2, S['track'] / 2
    for name, (sx, su) in {'wheel_fl': (1, ua), 'wheel_fr': (-1, ua), 'wheel_rl': (1, -ua), 'wheel_rr': (-1, -ua)}.items():
        wheel(name, M, S, sx, coll, body, (sx * x, -su, S['r']))
    for name, c in (('light_fl', hl[0]), ('light_fr', hl[1]), ('tail_l', tl[0]), ('tail_r', tl[1])):
        empty(coll, name, c if c is not None else V((0, 0, 0)), body)
    plate_node(coll, 'plate_f', body, (0, -F, 0.46), (0, 1, 0), body, off=0.015)
    plate_node(coll, 'plate_r', body, (0, -B, 0.75), (0, -1, 0), body, off=0.011)
    return body, S


if __name__ == '__main__':
    run(NAME, HERE, build)
