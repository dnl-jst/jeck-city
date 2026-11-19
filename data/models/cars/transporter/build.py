"""Transporter: panel van (≈ 4.90 × 1.90 × 1.97 m, wheelbase 3.0 m, 215/65 R16 on steel wheels).

Laid out like today's mid-size vans: a short sloping bonnet, the cab behind the front axle. The cab doors start just
behind the wheel centre, the rear half of the front wheel arch is cut out of their lower front corner; the driver
sits about 0.95 m behind the axle. A driver's seat and a double bench, a bulkhead behind them; the load space has no
side windows. The sliding door (right) and the rear wing doors stay shut.

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
    # nose, bonnet rising to the foot of the windscreen (u 1.45), windscreen up to the roof (u 0.68)
    top=[(B, 1.93), (-2.36, 1.962), (-2.0, 1.975), (0.5, 1.972), (0.68, 1.94), (1.05, 1.63), (1.45, 1.33),
         (1.9, 1.26), (2.3, 1.18), (2.44, 1.13), (F, 1.06)],
    belt=[(B, 1.25), (1.35, 1.25), (1.9, 1.17), (2.3, 1.06), (F, 0.96)],
    bottom=[(B, 0.48), (-2.2, 0.33), (-1.6, 0.25), (1.6, 0.25), (2.25, 0.33), (F, 0.4)],
    width=[(B, 0.915), (-2.38, 0.95), (1.9, 0.952), (2.3, 0.93), (2.42, 0.88), (F, 0.8)],
    topw=[(B, 0.86), (-2.36, 0.875), (0.68, 0.875), (1.45, 0.9), (2.3, 0.86), (F, 0.76)],
    widest=0.45, crown=0.03, rail=0.04, cap_bulge=0.05,
    screen=(1.45, 0.68),
    topglass=[(1.43, 0.7)],
    side=[(1.27, 0.1)],  # the cab door's pane, framed all round
    extra=[1.5, -1.5, 0.0],
    step=0.18,
    cap_crease=0.6,
)
S['face_mat'] = lambda u, seg: 'pillar' if seg == 5 and 0.03 <= u <= 1.31 else None

# cab doors from just behind the front wheel centre to the B-pillar; as CAR_SEATS
DOORS = {'door_fl': dict(u=(0.03, 1.31), side=1, hinge_x=0.94, relief=True), 'door_fr': dict(u=(0.03, 1.31), side=-1, hinge_x=-0.94, relief=True)}
LAYOUT = dict(
    seats=[(0.47, 0.55, 1.0), (-0.5, 0.55, 1.0)], front=1,
    wheel=dict(x=0.47, u=0.98, z=1.33, rake=0.55, r=0.2),
    floor=0.56, half_w=0.895, firewall=1.5, dash=dict(u0=1.24, top=1.27),
    shelf=None, mirror=None, tunnel=False, console=False,
    bench=dict(w=0.86, cx=-0.4), bulkhead=dict(u=-0.14, top=1.92),
    panels={'door_fl': (0.1, 1.2), 'door_fr': (0.1, 1.2)}, panel_z=0.95, panel_h=0.5,
)

HEAD = poly_round([(-0.17, -0.05), (0.2, -0.06), (0.22, 0.05), (-0.17, 0.045)], 0.02)
TAIL = poly_round([(-0.06, -0.22), (0.08, -0.22), (0.08, 0.22), (-0.06, 0.22)], 0.025)
HEAD_AT, TAIL_AT = (F, 0.62, 0.95, HEAD, 0.4), (B, 0.82, 1.0, TAIL, 0.12)


def build(coll, lod=False):
    M = car_materials2((0.86, 0.87, 0.85))

    def cuts(skin):
        return [o for o in lamp_cuts(skin, M, True, *HEAD_AT) + lamp_cuts(skin, M, False, *TAIL_AT) if o]

    sh = build_lod_shell(S, M, coll) if lod else build_shell(S, M, coll, DOORS, cuts)
    skin = sh.skin
    d, p = sh.part('decals'), sh.part('details')
    # front: big black bumper, grille with chrome bars between wide lamps
    sh.decal('trim', (0, -F, 0.5), (0, 1, 0), poly_round([(-0.8, -0.12), (0.8, -0.12), (0.8, 0.14), (-0.8, 0.14)], 0.05), off=0.01, bulge=0.01)
    sh.decal('trim', (0, -F, 0.86), (0, 1, 0), poly_round([(-0.4, -0.07), (0.4, -0.07), (0.42, 0.07), (-0.42, 0.07)], 0.02), off=0.006)
    for z in (0.83, 0.87, 0.91):
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
        handle(sh, s, 0.17, 1.16, mat='trim')  # cab door
        seams = [] if not lod else [(1.31, 0.75, 1.25), (0.03, 0.33, 1.9)]
        if s == -1:  # sliding door: its front edge is the cab door's rear edge; rear edge, rail and handle
            seams.append((-1.0, 0.33, 1.9))
            if not lod:
                seams.append((0.0, 0.33, 1.9))  # behind the cab door's gap the body carries the sliding door's front edge
            sh.decal('dark', (s, 1.6, 1.3), sd, rrect(1.2, 0.012, 0.004), off=0.002)
            sh.decal('trim', (s, 0.15, 1.16), sd, rrect(0.15, 0.03, 0.012), off=0.004, bulge=0.008)
        for u0, z0, z1 in seams:
            sh.decal('dark', (s, -u0, (z0 + z1) / 2), sd, rrect(0.009, z1 - z0, 0.003), off=0.0015)
        for u0, w in ((-0.53, 1.02), (0.57, 1.0), (2.2, 0.3), (-2.12, 0.4)):  # side protection: load space, cab door, the corners
            sh.decal('trim', (s, -u0, 0.47), sd, rrect(w, 0.14, 0.04), off=0.008, bulge=0.006)
        sh.decal('indicator', (s, -2.08, 0.9), sd, rrect(0.07, 0.025, 0.012), bulge=0.004)
        mirror2(sh.part('details', (s * 0.93, -1.2, 1.36)), M, (s * 0.93, -1.2, 1.36), s, mat='trim')
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
    run2(NAME, HERE, build, review_shots(LAYOUT, cut_z=1.6, look=(0.7, 0.35)))
