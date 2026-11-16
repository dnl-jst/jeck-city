"""Smart-style city two-seater (≈ 2.70 × 1.66 × 1.55 m, wheelbase 1.87 m): short nose, tall glasshouse, silver
safety cell ("tridion") framing the coloured panels, panorama roof.

Run headless:  blender -b --factory-startup --python data/models/cars/smart/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carparts import (V, Part, build_body, car_materials, decal, decal_object, empty, exhaust, lamp_pair, mirror,  # noqa: E402
                      poly_round, rrect, run, wheel, wipers)

NAME = 'smart'
F, B = 1.405, -1.295
CELL = (-0.40, -0.72)  # u range of the tridion pillar behind the door

S = dict(
    wb=1.87, track=1.46, r=0.29, rim_r=0.19, tyre_w=0.175, spokes=3, double_spokes=True,
    front=F, rear=B,
    top=[(B, 1.42), (-1.25, 1.49), (-1.12, 1.535), (-0.8, 1.55), (0.15, 1.545), (0.35, 1.515), (0.75, 1.22), (1.12, 0.925),
         (1.27, 0.85), (1.36, 0.785), (F, 0.7)],
    belt=[(B, 1.0), (-0.6, 0.985), (1.1, 0.9), (1.3, 0.79), (F, 0.68)],
    bottom=[(B, 0.4), (-1.05, 0.27), (1.0, 0.26), (F, 0.34)],
    width=[(B, 0.78), (-1.18, 0.83), (1.18, 0.83), (1.33, 0.8), (F, 0.72)],
    topw=[(B, 0.7), (-1.18, 0.685), (0.35, 0.67), (1.12, 0.76), (1.3, 0.73), (F, 0.62)],
    widest=0.45, crown=0.03,
    screen=(1.12, 0.35),
    topglass=[(1.1, 0.37), (0.28, -1.08)],
    side=[(1.1, CELL[0]), (CELL[1], -1.12)],
    extra=[0.935, -0.935, CELL[0], CELL[1]],
    step=0.12,
    cap_crease=0.5,
)


def tridion(u, seg):
    if CELL[1] <= u <= CELL[0] and seg >= 1:
        return 'tridion'  # the pillar behind the door, from the sill over the roof
    if seg == 6 and u < 0.36:
        return 'tridion'  # roof rails
    if seg == 7 and (u < -1.08 or 0.28 < u < 0.37):
        return 'tridion'  # roof bows front and rear
    if seg == 1 and -0.95 < u < 0.95:
        return 'tridion'  # sills
    return None


S['face_mat'] = tridion


def build(coll):
    M = car_materials((0.95, 0.75, 0.05))
    body = build_body(S, M, coll)
    d = Part('decals')
    # front: big teardrop lamps on the corners, small dark grille, plate low
    head = poly_round([(-0.13, -0.05), (0.08, -0.08), (0.15, 0.0), (0.12, 0.08), (-0.1, 0.06)], 0.04)
    hl = lamp_pair(d, body, M, 'lamp_front', F, 0.55, 0.78, head, d_side=0.6, bulge=0.016)
    decal(d, body, M['trim'], (0, -F, 0.62), (0, 1, 0), poly_round([(-0.32, -0.07), (0.32, -0.07), (0.28, 0.06), (-0.28, 0.06)], 0.03), bulge=0.003)
    decal(d, body, M['tridion'], (0, -F, 0.635), (0, 1, 0), rrect(0.07, 0.07, 0.03), off=0.01)  # badge
    decal(d, body, M['trim'], (0, -F, 0.42), (0, 1, 0), poly_round([(-0.62, -0.1), (0.62, -0.1), (0.58, 0.07), (-0.58, 0.07)], 0.04), off=0.006, bulge=0.006)
    decal(d, body, M['plate'], (0, -F, 0.45), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.016)
    decal(d, body, M['plate_eu'], (0.235, -F, 0.45), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.018)
    # rear: glass tailgate, vertical lamps in the tridion corners, black bumper
    decal(d, body, M['glass'], (0, -B, 1.24), (0, -1, 0), rrect(1.18, 0.32, 0.06), off=0.004)
    tail = poly_round([(-0.06, -0.13), (0.09, -0.13), (0.09, 0.13), (-0.06, 0.13)], 0.04)
    tl = lamp_pair(d, body, M, 'lamp_rear', B, 0.68, 0.92, tail, d_side=0.55, front=False)
    decal(d, body, M['trim'], (0, -B, 0.45), (0, -1, 0), poly_round([(-0.8, -0.1), (0.8, -0.1), (0.78, 0.09), (-0.78, 0.09)], 0.04), off=0.008, bulge=0.006)
    decal(d, body, M['plate'], (0, -B, 0.76), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.006)
    decal(d, body, M['plate_eu'], (-0.235, -B, 0.76), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.008)
    for s in (1, -1):
        sd = V((-s, 0, 0))
        decal(d, body, M['dark'], (s, -1.0, 0.64), sd, rrect(0.008, 0.62, 0.003), off=0.0015)  # door front edge
        decal(d, body, M['trim'], (s, 0.25, 0.86), sd, rrect(0.15, 0.03, 0.012), off=0.004, bulge=0.008)
        decal(d, body, M['trim'], (s, 0.95, 0.75), sd, rrect(0.12, 0.06, 0.02), off=0.004)  # side air intake
        decal(d, body, M['indicator'], (s, -1.15, 0.78), sd, rrect(0.06, 0.022, 0.011), bulge=0.004)
    dec = decal_object(d, coll, body)

    p = Part('details')
    for s in (1, -1):
        mirror(p, M, (s * 0.78, -0.9, 1.0), s, mat='trim')
    wipers(p, M, body, S, n=1)
    det = p.to_object(coll)
    det.parent = body

    ua, x = S['wb'] / 2, S['track'] / 2
    for name, (sx, su) in {'wheel_fl': (1, ua), 'wheel_fr': (-1, ua), 'wheel_rl': (1, -ua), 'wheel_rr': (-1, -ua)}.items():
        wheel(name, M, S, sx, coll, body, (sx * x, -su, S['r']))
    for name, c in (('light_fl', hl[0]), ('light_fr', hl[1]), ('tail_l', tl[0]), ('tail_r', tl[1])):
        empty(coll, name, c if c is not None else V((0, 0, 0)), body)
    return body, S


if __name__ == '__main__':
    run(NAME, HERE, build)
