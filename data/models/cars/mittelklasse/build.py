"""Mittelklasse: four-door saloon (≈ 4.76 × 1.83 × 1.44 m, wheelbase 2.82 m, 225/50 R17).

Run headless:  blender -b --factory-startup --python data/models/cars/mittelklasse/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carbody import (V, arch_lip, build_lod_shell, build_shell, bulb, car_materials2, handle, lamp_cuts, lamp_units,  # noqa: E402
                     mirror2, projector, recess, run2, shark_fin, wheels_and_lamps)
from carinterior import blob, build_interior, review_shots  # noqa: E402
from carparts import exhaust, lamp_pair, plate_node, poly_round, rrect, wipers  # noqa: E402

NAME = 'mittelklasse'
F, B = 2.31, -2.45

S = dict(
    wb=2.82, track=1.58, r=0.33, rim_r=0.225, tyre_w=0.225, spokes=5, double_spokes=False,
    front=F, rear=B,
    top=[(B, 0.98), (-2.40, 1.04), (-2.2, 1.06), (-1.88, 1.085), (-1.55, 1.27), (-1.15, 1.39), (-0.5, 1.435), (0.05, 1.42),
         (0.55, 1.17), (0.95, 0.965), (1.6, 0.875), (2.15, 0.78), (2.27, 0.725), (F, 0.66)],
    belt=[(B, 0.96), (-2.0, 0.985), (-1.0, 0.97), (0.95, 0.925), (1.6, 0.85), (2.2, 0.71), (F, 0.63)],
    bottom=[(B, 0.38), (-2.15, 0.25), (-1.4, 0.17), (1.4, 0.17), (2.05, 0.23), (F, 0.29)],
    width=[(B, 0.81), (-2.35, 0.885), (-2.1, 0.915), (1.9, 0.915), (2.12, 0.88), (2.25, 0.81), (F, 0.69)],
    topw=[(B, 0.78), (-2.0, 0.81), (-1.88, 0.78), (-1.15, 0.69), (0.05, 0.69), (0.95, 0.8), (1.6, 0.83), (2.15, 0.77), (F, 0.62)],
    widest=0.42,
    screen=(0.95, 0.05),
    topglass=[(0.93, 0.07), (-1.17, -1.86)],
    # a pane in each door, framed all round, and a fixed quarter light in the body
    side=[(0.91, -0.1), (-0.2, -0.97), (-1.09, -1.5)],
    extra=[1.41, -1.41, 0.0],
    step=0.16,
    shoulder=0.02, cap_bulge=0.05,
    creases={2: 0.5, 3: 0.45, 4: 0.7, 5: 0.5, 6: 0.8, 7: 0.8},
)
S['face_mat'] = lambda u, seg: 'pillar' if seg == 5 and -1.03 <= u <= 0.95 else None
S['trim_faces'] = lambda u, ax, z, mat: 'trim' if mat == 'paint' and z < 0.23 else None

# doors: front 1.10 m (from the foot of the windscreen), rear 0.88 m, ending just ahead of the rear wheel arch (a door cut by the arch leaves slivers); as CAR_SEATS
DOORS = {
    'door_fl': dict(u=(-0.15, 0.95), side=1, hinge_x=0.9), 'door_fr': dict(u=(-0.15, 0.95), side=-1, hinge_x=-0.9),
    'door_rl': dict(u=(-1.03, -0.15), side=1, hinge_x=0.905), 'door_rr': dict(u=(-1.03, -0.15), side=-1, hinge_x=-0.905),
}
LAYOUT = dict(
    seats=[(0.38, 0.09, 0.47), (-0.38, 0.09, 0.47), (0.37, -0.74, 0.5), (-0.37, -0.74, 0.5)], front=2,
    wheel=dict(x=0.38, u=0.51, z=0.85, rake=0.42, r=0.185),
    floor=0.2, half_w=0.885, firewall=1.06, dash=dict(u0=0.62, top=0.94),
    shelf=dict(u0=-1.14, u1=-1.9, z=0.975), mirror=(0.18, 1.3), bench=dict(w=1.4),
    panels={'door_fl': (-0.11, 0.86), 'door_fr': (-0.11, 0.86), 'door_rl': (-0.97, -0.2), 'door_rr': (-0.97, -0.2)},
)

HEAD = poly_round([(-0.2, -0.045), (0.17, -0.05), (0.23, 0.01), (0.21, 0.05), (-0.2, 0.035)], 0.02)
TAIL = poly_round([(-0.2, -0.05), (0.22, -0.06), (0.24, 0.05), (-0.2, 0.05)], 0.02)
GRILLE = poly_round([(-0.31, -0.085), (0.31, -0.085), (0.34, 0.055), (-0.34, 0.055)], 0.025)
INTAKE = poly_round([(-0.62, -0.06), (0.62, -0.06), (0.56, 0.06), (-0.56, 0.06)], 0.04)
HEAD_AT, TAIL_AT = (F, 0.6, 0.66, HEAD, 0.5), (B, 0.6, 0.9, TAIL, 0.6)


def belt_line(sh, s, u0, u1):
    """A piece of the chrome window line along the belt, from u0 to u1 on side s."""
    def z(u):
        return 0.957 - (u + 1.5) / 2.4 * 0.018
    um = (u0 + u1) / 2
    pts = [(s * (u0 - um), z(u0) - 0.014 - z(um)), (s * (u1 - um), z(u1) - 0.014 - z(um)), (s * (u1 - um), z(u1) - z(um)), (s * (u0 - um), z(u0) - z(um))]
    sh.decal('chrome', (s, -um, z(um)), (-s, 0, 0), pts[::s], off=0.003)


def build(coll, lod=False):
    M = car_materials2((0.55, 0.56, 0.58))

    def cuts(skin):
        out = lamp_cuts(skin, M, True, *HEAD_AT) + lamp_cuts(skin, M, False, *TAIL_AT)
        out.append(recess(skin, M['dark'], (0, -F, 0.6), (0, 1, 0), GRILLE))
        out.append(recess(skin, M['dark'], (0, -F, 0.36), (0, 1, 0), INTAKE))
        return [o for o in out if o]

    sh = build_lod_shell(S, M, coll) if lod else build_shell(S, M, coll, DOORS, cuts)
    skin = sh.skin
    d, p = sh.part('decals'), sh.part('details')
    # grille: chrome frame round a dark mesh, a wide lower intake
    if lod:
        sh.decal('chrome', (0, -F, 0.6), (0, 1, 0), poly_round([(-0.33, -0.1), (0.33, -0.1), (0.36, 0.07), (-0.36, 0.07)], 0.03), bulge=0.004)
        hl = lamp_pair(d, skin, M, 'lamp_front', *HEAD_AT[:4], d_side=0.5)
        tl = lamp_pair(d, skin, M, 'lamp_rear', *TAIL_AT[:4], d_side=0.6, front=False)
        sh.decal('trim', (0, -F, 0.6), (0, 1, 0), GRILLE, off=0.008)
        sh.decal('trim', (0, -F, 0.36), (0, 1, 0), INTAKE, bulge=0.003)
    else:
        def head(p_, s, c, n):
            for dx in (-0.09, 0.03):
                projector(sh, p_, c + V((s * dx, 0, 0.003)), n, r=0.034)
            loc, _ = sh.surface(c + V((s * 0.17, 0, 0.012)), n)
            blob(p_, loc + n * 0.012, (0.06, 0.02, 0.03), M['indicator'], r=0.008)

        def tail(p_, s, c, n):
            bulb(sh, p_, c + V((s * 0.1, 0, 0)), n, 'indicator', r=0.03)
            bulb(sh, p_, c + V((-s * 0.08, 0, 0)), n, 'chrome', r=0.03)
        hl = lamp_units(sh, True, *HEAD_AT, head)
        tl = lamp_units(sh, False, *TAIL_AT, tail)
        frame = [sh.surface((x, -F, 0.6 + y), (0, 1, 0))[0] for x, y in GRILLE]
        p.tube([q + V((0, -0.004, 0)) for q in frame + frame[:1]], 0.008, M['chrome'], seg=6, caps=False)
        loc, _ = sh.surface((0, -F, 0.6), (0, 1, 0))
        for dz in (-0.045, -0.015, 0.015):
            p.box(V((0, loc.y + 0.012, 0.6 + dz)), (0.6, 0.012, 0.009), M['chrome'])
        loc, _ = sh.surface((0, -F, 0.36), (0, 1, 0))
        for dz in (-0.025, 0.02):
            p.box(V((0, loc.y + 0.012, 0.36 + dz)), (1.1, 0.012, 0.01), M['trim'])
    sh.decal('plate', (0, -F, 0.46), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.012)
    sh.decal('plate_eu', (-0.235, -F, 0.46), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.014)
    for s in (1, -1):
        sh.decal('lamp_front', (s * 0.66, -F, 0.38), (-s * 0.35, 1, 0), rrect(0.12, 0.035, 0.015), bulge=0.004)
    # rear: chrome strip on the boot lid between the lamps, plate, apron
    sh.decal('chrome', (0, -B, 0.9), (0, -1, 0), rrect(0.6, 0.02, 0.008), off=0.004)
    sh.decal('plate', (0, -B, 0.75), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.008)
    sh.decal('plate_eu', (0.235, -B, 0.75), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.01)
    sh.decal('trim', (0, -B, 0.46), (0, -1, 0), poly_round([(-0.76, -0.045), (0.76, -0.045), (0.72, 0.045), (-0.72, 0.045)], 0.03), off=0.003)
    for s in (1, -1):
        sd = V((-s, 0, 0))
        for u in (0.02, -0.86):  # near the doors' rear edges
            handle(sh, s, u, 0.86, mat='chrome')
        if lod:  # no door gaps on the distance model: seams
            for u0, z0, z1 in ((0.95, 0.3, 0.93), (-0.15, 0.27, 0.97), (-1.03, 0.3, 0.98)):
                sh.decal('dark', (s, -u0, (z0 + z1) / 2), sd, rrect(0.008, z1 - z0, 0.003), off=0.0015)
        for u0, u1 in ((-0.13, 0.88), (-1.01, -0.17)):  # on the doors only
            belt_line(sh, s, u0, u1)
        sh.decal('indicator', (s, -1.92, 0.76), sd, rrect(0.07, 0.022, 0.011), bulge=0.004)
        mirror2(sh.part('details', (s * 0.87, -0.84, 0.98)), M, (s * 0.87, -0.84, 0.98), s)
        exhaust(p, M, skin, s * 0.5, B, r=0.042)
        if not lod:
            for ua in (S['wb'] / 2, -S['wb'] / 2):
                arch_lip(sh, s, ua)
    wipers(p, M, skin, S)
    loc, _ = sh.surface((0, 1.0, 3.0), (0, 0, -1))
    shark_fin(p, M, loc)  # roof antenna
    if not lod:
        build_interior(sh, LAYOUT)
    plate_node(coll, 'plate_f', skin, (0, -F, 0.46), (0, 1, 0), sh.body, off=0.015)
    plate_node(coll, 'plate_r', skin, (0, -B, 0.75), (0, -1, 0), sh.body, off=0.011)
    sh.finish()
    wheels_and_lamps(sh, coll, hl, tl)
    return sh.body, S, sh


if __name__ == '__main__':
    run2(NAME, HERE, build, review_shots(LAYOUT))
