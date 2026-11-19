"""Transporter: panel van (≈ 4.90 × 1.90 × 1.97 m, wheelbase 3.0 m, 215/65 R16 on steel wheels).

Two cab doors over the front wheels, a driver's seat and a double bench, a bulkhead behind them; the load space has
no side windows. The sliding door (right) and the rear wing doors stay shut.

Run headless:  blender -b --factory-startup --python data/models/cars/transporter/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carbody import (V, arch_lip, build_lod_shell, build_shell, bulb, car_materials2, handle, lamp_cuts, lamp_units,  # noqa: E402
                     mirror2, projector, run2, wheels_and_lamps)
from carinterior import build_interior, review_shots  # noqa: E402
from carparts import exhaust, lamp_pair, plate_node, poly_round, rrect, wipers  # noqa: E402

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
    side=[(1.9, 1.05)],  # the cab door's pane, framed all round
    extra=[1.5, -1.5, 1.0],
    step=0.18,
    cap_crease=0.6,
)
S['face_mat'] = lambda u, seg: 'pillar' if seg == 5 and 1.0 <= u <= 1.95 else None

# the cab doors sit over the front wheels, whose arches are cut out of their lower edge; as CAR_SEATS
DOORS = {'door_fl': dict(u=(1.0, 1.95), side=1, hinge_x=0.94), 'door_fr': dict(u=(1.0, 1.95), side=-1, hinge_x=-0.94)}
LAYOUT = dict(
    seats=[(0.47, 1.27, 0.92), (-0.5, 1.27, 0.92)], front=1,
    wheel=dict(x=0.47, u=1.56, z=1.22, rake=0.62, r=0.2),
    floor=0.56, half_w=0.895, firewall=2.06, dash=dict(u0=1.64, top=1.15),
    shelf=None, mirror=None, tunnel=False, console=False,
    bench=dict(w=0.86, cx=-0.4), bulkhead=dict(u=0.6, top=1.92),
    panels={'door_fl': (1.06, 1.86), 'door_fr': (1.06, 1.86)}, panel_z=0.9, panel_h=0.36,
)

HEAD = poly_round([(-0.17, -0.07), (0.2, -0.08), (0.22, 0.07), (-0.17, 0.065)], 0.02)
TAIL = poly_round([(-0.06, -0.22), (0.08, -0.22), (0.08, 0.22), (-0.06, 0.22)], 0.025)
HEAD_AT, TAIL_AT = (F, 0.66, 0.86, HEAD, 0.4), (B, 0.82, 1.0, TAIL, 0.12)


def build(coll, lod=False):
    M = car_materials2((0.86, 0.87, 0.85))

    def cuts(skin):
        return [o for o in lamp_cuts(skin, M, True, *HEAD_AT) + lamp_cuts(skin, M, False, *TAIL_AT) if o]

    sh = build_lod_shell(S, M, coll) if lod else build_shell(S, M, coll, DOORS, cuts)
    skin = sh.skin
    d, p = sh.part('decals'), sh.part('details')
    # front: big black bumper, grille with chrome bars between wide lamps
    sh.decal('trim', (0, -F, 0.5), (0, 1, 0), poly_round([(-0.8, -0.12), (0.8, -0.12), (0.8, 0.14), (-0.8, 0.14)], 0.05), off=0.01, bulge=0.01)
    sh.decal('trim', (0, -F, 0.85), (0, 1, 0), poly_round([(-0.4, -0.09), (0.4, -0.09), (0.42, 0.09), (-0.42, 0.09)], 0.02), off=0.006)
    for z in (0.81, 0.86, 0.91):
        sh.decal('chrome', (0, -F, z), (0, 1, 0), rrect(0.8, 0.012, 0.005), off=0.01)
    if lod:
        hl = lamp_pair(d, skin, M, 'lamp_front', *HEAD_AT[:4], d_side=0.4)
        tl = lamp_pair(d, skin, M, 'lamp_rear', *TAIL_AT[:4], d_side=0.12, front=False)
    else:
        def head(p_, s, c, n):
            projector(sh, p_, c + V((-s * 0.04, 0, 0)), n, r=0.055)
            bulb(sh, p_, c + V((s * 0.13, 0, 0)), n, 'indicator', r=0.035)

        def tail(p_, s, c, n):
            for dz, mat in ((0.13, 'indicator'), (-0.13, 'chrome')):
                bulb(sh, p_, c + V((0, 0, dz)), n, mat, r=0.035)
        hl = lamp_units(sh, True, *HEAD_AT, head)
        tl = lamp_units(sh, False, *TAIL_AT, tail)
    sh.decal('plate', (0, -F, 0.5), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.022)
    sh.decal('plate_eu', (-0.235, -F, 0.5), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.024)
    # rear: two wing doors with dark windows, black bumper
    for s in (1, -1):
        sh.decal('glass_dark', (s * 0.38, -B, 1.6), (0, -1, 0), rrect(0.6, 0.42, 0.04), off=0.004)
    sh.decal('dark', (0, -B, 1.2), (0, -1, 0), rrect(0.01, 1.4, 0.004), off=0.002)  # door gap
    sh.decal('trim', (0, -B, 0.52), (0, -1, 0), poly_round([(-0.84, -0.1), (0.84, -0.1), (0.84, 0.08), (-0.84, 0.08)], 0.04), off=0.01, bulge=0.008)
    # the plate sits on the left wing door, clear of the gap between the doors
    sh.decal('plate', (0.4, -B, 0.78), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.006)
    sh.decal('plate_eu', (0.635, -B, 0.78), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.008)
    sh.decal('lamp_rear', (0, -B, 1.94), (0, -1, 0.3), rrect(0.3, 0.035, 0.015), off=0.004)  # third brake light
    for s in (1, -1):
        sd = V((-s, 0, 0))
        handle(sh, s, 1.13, 1.05, mat='trim')  # cab door
        seams = [] if not lod else [(1.95, 0.75, 1.12), (1.0, 0.33, 1.9)]
        if s == -1:  # sliding door: its front edge is the cab door's rear edge; rear edge, rail and handle
            seams.append((-0.05, 0.33, 1.9))
            sh.decal('dark', (s, 0.25, 1.42), sd, rrect(2.5, 0.012, 0.004), off=0.002)
            sh.decal('trim', (s, -0.8, 1.0), sd, rrect(0.15, 0.03, 0.012), off=0.004, bulge=0.008)
        for u0, z0, z1 in seams:
            sh.decal('dark', (s, -u0, (z0 + z1) / 2), sd, rrect(0.009, z1 - z0, 0.003), off=0.0015)
        for u0, w in ((-0.1, 1.9), (2.2, 0.3), (-2.12, 0.4)):  # side protection: between the arches, front and rear corners
            sh.decal('trim', (s, -u0, 0.47), sd, rrect(w, 0.14, 0.04), off=0.008, bulge=0.006)
        sh.decal('indicator', (s, -2.08, 0.9), sd, rrect(0.07, 0.025, 0.012), bulge=0.004)
        mirror2(sh.part('details', (s * 0.93, -1.82, 1.22)), M, (s * 0.93, -1.82, 1.22), s, mat='trim')
        if not lod:
            for ua in (S['wb'] / 2, -S['wb'] / 2):
                arch_lip(sh, s, ua, mat='trim')
    wipers(p, M, skin, S)
    exhaust(p, M, skin, -0.6, B, r=0.038)
    if not lod:
        build_interior(sh, LAYOUT)
    plate_node(coll, 'plate_f', skin, (0, -F, 0.5), (0, 1, 0), sh.body, off=0.025)
    plate_node(coll, 'plate_r', skin, (0.4, -B, 0.78), (0, -1, 0), sh.body, off=0.009)
    sh.finish()
    wheels_and_lamps(sh, coll, hl, tl)
    return sh.body, S, sh


if __name__ == '__main__':
    run2(NAME, HERE, build, review_shots(LAYOUT, cut_z=1.5, look=(1.2, 0.35)))
