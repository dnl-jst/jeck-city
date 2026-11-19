"""Transporter: short-wheelbase panel van with cab windows (≈ 4.90 × 1.90 × 1.97 m, wheelbase 3.0 m, 215/65 R16).

Run headless:  blender -b --factory-startup --python data/models/cars/transporter/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carparts import (plate_node, V, Part, build_body, car_materials, decal, decal_object, empty, exhaust, lamp_pair, mirror,  # noqa: E402
                      poly_round, rrect, run, wheel, wipers)

NAME = 'transporter'
F, B = 2.48, -2.42

S = dict(
    wb=3.0, track=1.62, r=0.343, rim_r=0.205, tyre_w=0.215, wheel='steel',
    front=F, rear=B,
    top=[(B, 1.93), (-2.36, 1.962), (-2.0, 1.975), (1.0, 1.972), (1.2, 1.94), (1.6, 1.56), (1.95, 1.18),
         (2.15, 1.1), (2.36, 1.02), (2.44, 0.95), (F, 0.87)],
    belt=[(B, 1.16), (1.9, 1.11), (2.3, 0.96), (F, 0.84)],
    bottom=[(B, 0.48), (-2.2, 0.33), (-1.6, 0.25), (1.6, 0.25), (2.25, 0.33), (F, 0.4)],
    width=[(B, 0.915), (-2.38, 0.95), (2.3, 0.952), (2.42, 0.92), (F, 0.85)],
    topw=[(B, 0.86), (-2.36, 0.875), (1.2, 0.875), (1.95, 0.9), (2.3, 0.88), (F, 0.8)],
    widest=0.45, crown=0.03, rail=0.04,
    screen=(1.95, 1.2),
    topglass=[(1.93, 1.22)],
    side=[(1.93, 1.04)],
    extra=[1.5, -1.5, 1.0],
    step=0.18,
    cap_crease=0.6,
)


def build(coll):
    M = car_materials((0.86, 0.87, 0.85))
    body = build_body(S, M, coll)
    d = Part('decals')
    # front: big black bumper and grille with chrome bars, wide lamps
    decal(d, body, M['trim'], (0, -F, 0.5), (0, 1, 0), poly_round([(-0.8, -0.12), (0.8, -0.12), (0.8, 0.14), (-0.8, 0.14)], 0.05), off=0.01, bulge=0.01)
    decal(d, body, M['trim'], (0, -F, 0.85), (0, 1, 0), poly_round([(-0.4, -0.09), (0.4, -0.09), (0.42, 0.09), (-0.42, 0.09)], 0.02), off=0.006)
    for z in (0.81, 0.86, 0.91):
        decal(d, body, M['chrome'], (0, -F, z), (0, 1, 0), rrect(0.8, 0.012, 0.005), off=0.01)
    head = poly_round([(-0.17, -0.07), (0.2, -0.08), (0.22, 0.07), (-0.17, 0.065)], 0.02)
    hl = lamp_pair(d, body, M, 'lamp_front', F, 0.66, 0.86, head, d_side=0.4)
    decal(d, body, M['plate'], (0, -F, 0.5), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.022)
    decal(d, body, M['plate_eu'], (0.235, -F, 0.5), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.024)
    # rear: tall lamps at the corners, two-wing doors with windows, black bumper
    tail = poly_round([(-0.06, -0.22), (0.08, -0.22), (0.08, 0.22), (-0.06, 0.22)], 0.025)
    tl = lamp_pair(d, body, M, 'lamp_rear', B, 0.82, 1.0, tail, d_side=0.12, front=False)
    for s in (1, -1):
        decal(d, body, M['glass'], (s * 0.38, -B, 1.6), (0, -1, 0), rrect(0.6, 0.42, 0.04), off=0.004)
    decal(d, body, M['dark'], (0, -B, 1.2), (0, -1, 0), rrect(0.01, 1.4, 0.004), off=0.002)  # door gap
    decal(d, body, M['trim'], (0, -B, 0.52), (0, -1, 0), poly_round([(-0.84, -0.1), (0.84, -0.1), (0.84, 0.08), (-0.84, 0.08)], 0.04), off=0.01, bulge=0.008)
    decal(d, body, M['plate'], (0, -B, 0.78), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.006)
    decal(d, body, M['plate_eu'], (-0.235, -B, 0.78), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.008)
    decal(d, body, M['lamp_rear'], (0, -B, 1.94), (0, -1, 0.3), rrect(0.3, 0.035, 0.015), off=0.004)  # third brake light
    for s in (1, -1):
        sd = V((-s, 0, 0))
        # cab door, sliding door (right side only), rear edge seams
        seams = [(2.0, 0.36, 1.12), (1.0, 0.33, 1.9)]
        if s == -1:
            seams.append((0.05, 0.33, 1.9))
        for u0, z0, z1 in seams:
            decal(d, body, M['dark'], (s, -u0, (z0 + z1) / 2), sd, rrect(0.009, z1 - z0, 0.003), off=0.0015)
        if s == -1:  # sliding-door rail
            decal(d, body, M['dark'], (s, 0.2, 1.42), sd, rrect(2.6, 0.012, 0.004), off=0.002)
            decal(d, body, M['trim'], (s, -0.15, 1.0), sd, rrect(0.15, 0.03, 0.012), off=0.004, bulge=0.008)
        decal(d, body, M['trim'], (s, -1.15, 1.05), sd, rrect(0.15, 0.03, 0.012), off=0.004, bulge=0.008)
        for u0, w in ((0.0, 2.1), (2.14, 0.42), (-2.12, 0.4)):  # side protection, between the arches
            decal(d, body, M['trim'], (s, -u0, 0.47), sd, rrect(w, 0.14, 0.04), off=0.008, bulge=0.006)
        decal(d, body, M['indicator'], (s, -2.08, 0.9), sd, rrect(0.07, 0.025, 0.012), bulge=0.004)
    dec = decal_object(d, coll, body)

    p = Part('details')
    for s in (1, -1):
        mirror(p, M, (s * 0.93, -1.86, 1.22), s, mat='trim')
    wipers(p, M, body, S)
    exhaust(p, M, body, -0.6, B, r=0.038)
    det = p.to_object(coll)
    det.parent = body

    ua, x = S['wb'] / 2, S['track'] / 2
    for name, (sx, su) in {'wheel_fl': (1, ua), 'wheel_fr': (-1, ua), 'wheel_rl': (1, -ua), 'wheel_rr': (-1, -ua)}.items():
        wheel(name, M, S, sx, coll, body, (sx * x, -su, S['r']))
    for name, c in (('light_fl', hl[0]), ('light_fr', hl[1]), ('tail_l', tl[0]), ('tail_r', tl[1])):
        empty(coll, name, c if c is not None else V((0, 0, 0)), body)
    plate_node(coll, 'plate_f', body, (0, -F, 0.5), (0, 1, 0), body, off=0.025)
    plate_node(coll, 'plate_r', body, (0, -B, 0.78), (0, -1, 0), body, off=0.009)
    return body, S


if __name__ == '__main__':
    run(NAME, HERE, build)
