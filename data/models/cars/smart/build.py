"""Smart: city two-seater (≈ 2.70 × 1.56 × 1.55 m, wheelbase 1.87 m, 175/55 R15).

Clearly narrower than the other cars. Two doors, two seats, a glass roof; the engine sits under the boot floor.

Run headless:  blender -b --factory-startup --python data/models/cars/smart/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carbody import (V, arch_lip, build_lod_shell, build_shell, bulb, car_materials2, handle, lamp_cuts, lamp_units,  # noqa: E402
                     mirror2, projector, recess, run2, wheels_and_lamps)
from carinterior import build_interior, review_shots  # noqa: E402
from carparts import lamp_pair, plate_node, poly_round, rrect, wipers  # noqa: E402

NAME = 'smart'
F, B = 1.405, -1.295
CELL = (-0.40, -0.72)  # u range of the pillar behind the door

S = dict(
    wb=1.87, track=1.36, r=0.29, rim_r=0.19, tyre_w=0.175, spokes=3, double_spokes=True,
    front=F, rear=B,
    # the roof starts to fall behind the seats into a sloping, rounded tail
    top=[(B, 1.0), (-1.27, 1.06), (-1.2, 1.16), (-1.05, 1.33), (-0.85, 1.47), (-0.6, 1.54), (-0.3, 1.555), (0.15, 1.545), (0.35, 1.515),
         (0.75, 1.22), (1.12, 0.925), (1.27, 0.85), (1.36, 0.785), (F, 0.7)],
    belt=[(B, 0.96), (-0.6, 0.985), (1.1, 0.9), (1.3, 0.79), (F, 0.68)],
    bottom=[(B, 0.4), (-1.05, 0.27), (1.0, 0.26), (F, 0.34)],
    width=[(B, 0.66), (-1.2, 0.75), (-1.0, 0.78), (1.18, 0.78), (1.33, 0.75), (F, 0.66)],
    topw=[(B, 0.6), (-1.18, 0.62), (0.35, 0.62), (1.12, 0.71), (1.3, 0.68), (F, 0.57)],
    widest=0.45, crown=0.03, cap_bulge=0.06,
    screen=(1.12, 0.35),
    topglass=[(1.1, 0.37), (0.28, -0.5), (-0.78, -1.22)],  # windscreen, glass roof, the sloping rear screen
    # the door pane, framed all round, and the fixed quarter light behind the pillar
    side=[(0.96, CELL[0] + 0.04), (CELL[1], -1.0)],
    extra=[0.935, -0.935, CELL[0], CELL[1]],
    step=0.12,
    cap_crease=0.5,
)


def trims(u, seg):
    if seg == 1 and -0.95 < u < 0.95:
        return 'trim'  # sills
    if seg in (1, 2) and u <= -0.95:
        return 'trim'  # the tail's lower corners belong to the black bumper
    if seg == 5 and CELL[0] < u <= 1.0:
        return 'pillar'  # the door's window frame
    return None  # the pillar behind the door is body colour


S['face_mat'] = trims

# one long door a side, from the cell pillar to the front wheel arch (which cuts its lower front corner); as CAR_SEATS
DOORS = {'door_fl': dict(u=(CELL[0], 1.0), side=1, hinge_x=0.765), 'door_fr': dict(u=(CELL[0], 1.0), side=-1, hinge_x=-0.765)}
LAYOUT = dict(
    seats=[(0.33, -0.2, 0.62), (-0.33, -0.2, 0.62)], front=2,
    wheel=dict(x=0.33, u=0.22, z=1.0, rake=0.45, r=0.18),
    floor=0.3, half_w=0.745, firewall=1.0, dash=dict(u0=0.34, top=0.96),
    shelf=dict(u0=-0.62, u1=-1.2, z=0.9), mirror=(0.47, 1.4), tunnel=False,
    panels={'door_fl': (-0.34, 0.5), 'door_fr': (-0.34, 0.5)},
)

HEAD = poly_round([(-0.13, -0.05), (0.08, -0.08), (0.15, 0.0), (0.12, 0.08), (-0.1, 0.06)], 0.04)
TAIL = poly_round([(-0.06, -0.11), (0.09, -0.11), (0.09, 0.11), (-0.06, 0.11)], 0.04)
GRILLE = poly_round([(-0.3, -0.065), (0.3, -0.065), (0.26, 0.055), (-0.26, 0.055)], 0.03)
HEAD_AT, TAIL_AT = (F, 0.5, 0.78, HEAD, 0.6), (B, 0.56, 0.8, TAIL, 0.55)


def build(coll, lod=False):
    M = car_materials2((0.95, 0.75, 0.05))

    def cuts(skin):
        out = lamp_cuts(skin, M, True, *HEAD_AT) + lamp_cuts(skin, M, False, *TAIL_AT)
        out.append(recess(skin, M['dark'], (0, -F, 0.62), (0, 1, 0), GRILLE))
        return [o for o in out if o]

    sh = build_lod_shell(S, M, coll) if lod else build_shell(S, M, coll, DOORS, cuts)
    skin = sh.skin
    d, p = sh.part('decals'), sh.part('details')
    # front: big teardrop lamps on the corners, a small dark grille with the badge, plate low on the bumper
    if lod:
        hl = lamp_pair(d, skin, M, 'lamp_front', *HEAD_AT[:4], d_side=0.6, bulge=0.016)
        tl = lamp_pair(d, skin, M, 'lamp_rear', *TAIL_AT[:4], d_side=0.55, front=False)
        sh.decal('trim', (0, -F, 0.62), (0, 1, 0), GRILLE, bulge=0.003)
    else:
        hl = lamp_units(sh, True, *HEAD_AT, lambda p_, s, c, n: projector(sh, p_, c + V((0, 0, 0.005)), n, r=0.05))

        def tail(p_, s, c, n):
            bulb(sh, p_, c + V((0, 0, 0.055)), n, 'indicator', r=0.028)
            bulb(sh, p_, c + V((0, 0, -0.055)), n, 'chrome', r=0.028)
        tl = lamp_units(sh, False, *TAIL_AT, tail)
        loc, _ = sh.surface((0, -F, 0.62), (0, 1, 0))
        for dz in (-0.03, 0.01):
            p.box(V((0, loc.y + 0.012, 0.62 + dz)), (0.5, 0.012, 0.009), M['trim'])
    sh.decal('chrome', (0, -F, 0.635), (0, 1, 0), rrect(0.07, 0.07, 0.03), off=0.03 if not lod else 0.01)  # badge
    sh.decal('trim', (0, -F, 0.42), (0, 1, 0), poly_round([(-0.56, -0.1), (0.56, -0.1), (0.52, 0.07), (-0.52, 0.07)], 0.04), off=0.006, bulge=0.006)
    sh.decal('plate', (0, -F, 0.45), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.016)
    sh.decal('plate_eu', (-0.235, -F, 0.45), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.018)
    # rear: black bumper, plate
    sh.decal('trim', (0, -B, 0.45), (0, -1, 0), poly_round([(-0.72, -0.1), (0.72, -0.1), (0.7, 0.09), (-0.7, 0.09)], 0.04), off=0.008, bulge=0.006)
    sh.decal('plate', (0, -B, 0.72), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.006)
    sh.decal('plate_eu', (0.235, -B, 0.72), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.008)
    for s in (1, -1):
        sd = V((-s, 0, 0))
        handle(sh, s, -0.22, 0.86, mat='trim')
        if lod:
            sh.decal('dark', (s, -1.0, 0.75), sd, rrect(0.008, 0.4, 0.003), off=0.0015)  # door front edge
        sh.decal('trim', (s, 0.95, 0.75), sd, rrect(0.12, 0.06, 0.02), off=0.004)  # side air intake
        sh.decal('indicator', (s, -1.15, 0.78), sd, rrect(0.06, 0.022, 0.011), bulge=0.004)
        mirror2(sh.part('details', (s * 0.73, -0.9, 1.0)), M, (s * 0.73, -0.9, 1.0), s, mat='trim')
        if not lod:
            for ua in (S['wb'] / 2, -S['wb'] / 2):
                arch_lip(sh, s, ua, mat='trim')
    wipers(p, M, skin, S, n=1)
    if not lod:
        build_interior(sh, LAYOUT)
    plate_node(coll, 'plate_f', skin, (0, -F, 0.45), (0, 1, 0), sh.body, off=0.019)
    plate_node(coll, 'plate_r', skin, (0, -B, 0.72), (0, -1, 0), sh.body, off=0.009)
    sh.finish()
    wheels_and_lamps(sh, coll, hl, tl)
    return sh.body, S, sh


if __name__ == '__main__':
    run2(NAME, HERE, build, review_shots(LAYOUT, cut_z=1.1))
