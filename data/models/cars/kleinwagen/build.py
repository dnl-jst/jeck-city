"""Kleinwagen: five-door compact hatchback (≈ 4.05 × 1.75 × 1.46 m, wheelbase 2.55 m, 185/65 R15).

Run headless:  blender -b --factory-startup --python data/models/cars/kleinwagen/build.py
Conventions: ../README.md.
"""
import math
import os
import sys

from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carbody import V, build_lod_shell, build_shell, car_materials2, pair, recess, run2  # noqa: E402
from carinterior import blob, build_interior, seat_manikins  # noqa: E402
from carparts import empty, exhaust, lamp_pair, mirror, poly_round, rrect, wheel, wipers  # noqa: E402

NAME = 'kleinwagen'
F, B = 2.075, -1.975  # u of the front and rear faces

S = dict(
    wb=2.55, track=1.50, r=0.305, rim_r=0.195, tyre_w=0.185, spokes=5, double_spokes=True,
    front=F, rear=B,
    top=[(B, 1.0), (-1.95, 1.05), (-1.82, 1.22), (-1.6, 1.36), (-1.3, 1.435), (-1.0, 1.455), (-0.3, 1.46), (0.25, 1.43),
         (0.62, 1.22), (0.95, 0.985), (1.45, 0.905), (1.9, 0.825), (2.03, 0.775), (F, 0.72)],
    belt=[(B, 0.98), (-1.6, 0.975), (-1.2, 0.955), (0.95, 0.915), (1.5, 0.87), (2.0, 0.76), (F, 0.70)],
    bottom=[(B, 0.42), (-1.8, 0.26), (-1.2, 0.19), (1.3, 0.19), (1.85, 0.26), (F, 0.34)],
    width=[(B, 0.77), (-1.9, 0.85), (-1.72, 0.875), (1.6, 0.875), (1.85, 0.84), (2.0, 0.77), (F, 0.66)],
    topw=[(B, 0.71), (-1.9, 0.69), (-1.6, 0.66), (0.25, 0.655), (0.95, 0.77), (1.5, 0.79), (1.9, 0.74), (F, 0.58)],
    widest=0.42,
    screen=(0.95, 0.25),
    topglass=[(0.93, 0.27), (-1.5, -1.93)],
    side=[(0.86, -0.06), (-0.16, -1.27)],  # each pane lies inside its door, framed all round
    extra=[1.275, -1.275, 0.0],
    step=0.15,
    shoulder=0.02, cap_bulge=0.05,
    creases={2: 0.5, 3: 0.45, 4: 0.7, 5: 0.5, 6: 0.8, 7: 0.8},  # 3: a crease along the flank
)
# gloss black window frames on the doors (the pillars between the panes)
S['face_mat'] = lambda u, seg: 'pillar' if seg == 5 and -1.33 <= u <= 0.9 else None


def lower_trim(u, ax, z, mat):
    """Unpainted sills."""
    if mat == 'paint' and z < 0.25:
        return 'trim'
    return None


S['trim_faces'] = lower_trim

HEAD = poly_round([(-0.17, -0.05), (0.12, -0.055), (0.21, 0.0), (0.2, 0.065), (-0.17, 0.045)], 0.025)
TAIL = poly_round([(-0.09, -0.08), (0.12, -0.08), (0.12, 0.09), (-0.05, 0.09)], 0.025)
GRILLE = rrect(0.62, 0.065, 0.03)
INTAKE = poly_round([(-0.5, -0.08), (0.5, -0.08), (0.44, 0.07), (-0.44, 0.07)], 0.04)
LAMP_DEPTH = 0.024  # recesses stay inside the 30 mm wall, so they keep their back


# doors: (rear u, hinge u), side (+1 = left), hinge axis x; as CAR_SEATS in packages/shared/src/physics/carseats.ts
DOORS = {
    'door_fl': dict(u=(-0.11, 0.90), side=1, hinge_x=0.86), 'door_fr': dict(u=(-0.11, 0.90), side=-1, hinge_x=-0.86),
    'door_rl': dict(u=(-1.33, -0.11), side=1, hinge_x=0.87), 'door_rr': dict(u=(-1.33, -0.11), side=-1, hinge_x=-0.87),
}

# interior (carinterior.py); the seats are CAR_SEATS' hip points
LAYOUT = dict(
    seats=[(0.37, 0.05, 0.50), (-0.37, 0.05, 0.50), (0.36, -0.78, 0.53), (-0.36, -0.78, 0.53)], front=2,
    wheel=dict(x=0.37, u=0.47, z=0.88, rake=0.42, r=0.185),
    floor=0.22, half_w=0.845, firewall=1.02, dash=dict(u0=0.58, top=0.95),
    shelf=dict(u0=-1.16, u1=-1.76, z=0.965), mirror=(0.36, 1.33),
    panels={'door_fl': (-0.07, 0.8), 'door_fr': (-0.07, 0.8), 'door_rl': (-0.86, -0.15), 'door_rr': (-0.86, -0.15)},
)


def build(coll, lod=False):
    M = car_materials2((0.08, 0.22, 0.5))

    def cuts(skin):
        out = [recess(skin, M['lamp_front'], c, d, ol, LAMP_DEPTH) for _, c, d, ol in pair(True, F, 0.6, 0.715, HEAD, 0.45)]
        out += [recess(skin, M['lamp_rear'], c, d, ol, LAMP_DEPTH) for _, c, d, ol in pair(False, B, 0.68, 0.88, TAIL, 0.5)]
        out.append(recess(skin, M['dark'], (0, -F, 0.715), (0, 1, 0), GRILLE, LAMP_DEPTH))
        out.append(recess(skin, M['dark'], (0, -F, 0.45), (0, 1, 0), INTAKE, LAMP_DEPTH))
        return [o for o in out if o]

    sh = build_lod_shell(S, M, coll) if lod else build_shell(S, M, coll, DOORS, cuts)
    body, skin = sh.body, sh.skin
    d = sh.part('decals')
    p = sh.part('details')
    if lod:  # flat lamps and grilles
        hl = lamp_pair(d, skin, M, 'lamp_front', F, 0.6, 0.715, HEAD, d_side=0.45)
        tl = lamp_pair(d, skin, M, 'lamp_rear', B, 0.68, 0.88, TAIL, d_side=0.5, front=False)
        sh.decal('trim', (0, -F, 0.715), (0, 1, 0), GRILLE, bulge=0.002)
        sh.decal('trim', (0, -F, 0.45), (0, 1, 0), INTAKE, bulge=0.003)
    else:
        # lamp units: a recess lined with the lamp material, projectors / bulbs in it, a clear cover flush with the body
        hl, tl = [], []
        for s, c, dr, ol in pair(True, F, 0.6, 0.715, HEAD, 0.45):
            hl.append(sh.decal('lens', c, dr, ol, off=0.0005))
            for dx in (-0.075, 0.07):
                loc, _ = sh.surface(c + V((s * dx, 0, 0.004)), dr)
                n = dr.normalized()
                p.cyl(loc + n * LAMP_DEPTH, loc + n * 0.007, 0.036, M['chrome'], seg=20)
                p.cyl(loc + n * LAMP_DEPTH, loc + n * 0.004, 0.027, M['lamp_front'], seg=20)
            loc, _ = sh.surface(c + V((s * 0.17, 0, 0.02)), dr)
            blob(p, loc + dr.normalized() * 0.012, (0.05, 0.02, 0.035), M['indicator'], r=0.008)
        for s, c, dr, ol in pair(False, B, 0.68, 0.88, TAIL, 0.5):
            tl.append(sh.decal('lens_red', c, dr, ol, off=0.0005))
            n = dr.normalized()
            for dz, mat, r in ((-0.045, 'chrome', 0.026), (0.04, 'indicator', 0.026)):
                loc, _ = sh.surface(c + V((0, 0, dz)), dr)
                p.cyl(loc + n * LAMP_DEPTH, loc + n * 0.006, r, M[mat], seg=16)
        # grille and intake: bars across the recesses, the plate on a holder
        for zc, zs, w in ((0.715, (-0.016, 0.016), 0.58), (0.45, (-0.045, 0.045), 0.84)):
            loc, _ = sh.surface((0, -F, zc), (0, 1, 0))
            for dz in zs:
                p.box(V((0, loc.y + 0.012, zc + dz)), (w, 0.012, 0.01), M['trim'])
        loc, _ = sh.surface((0, -F, 0.47), (0, 1, 0))
        p.box(V((0, loc.y + 0.006, 0.47)), (0.56, 0.014, 0.135), M['trim'])
    sh.decal('plate', (0, -F, 0.47), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.012)
    sh.decal('plate_eu', (-0.235, -F, 0.47), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.014)
    for s in (1, -1):  # fog lamps
        sh.decal('lamp_front', (s * 0.62, -F, 0.42), (-s * 0.3, 1, 0), rrect(0.11, 0.05, 0.02), bulge=0.004)
    # rear: plate in the tailgate, tailgate seam, lip spoiler with the third brake light
    sh.decal('plate', (0, -B, 0.72), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.008)
    sh.decal('plate_eu', (0.235, -B, 0.72), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.01)
    sh.decal('dark', (0, -B, 0.97), (0, -1, 0), rrect(1.2, 0.01, 0.004), off=0.002)
    sh.decal('trim', (0, -B, 0.5), (0, -1, 0), poly_round([(-0.74, -0.05), (0.74, -0.05), (0.7, 0.05), (-0.7, 0.05)], 0.03), off=0.003)
    tilt = Matrix.Rotation(-0.24, 3, 'X')
    lip = V((0, 1.5, 1.4))
    blob(p, lip, (1.12, 0.17, 0.035), M['paint'], tilt, r=0.014)
    p.box(lip + tilt @ V((0, 0.087, 0.0)), (0.34, 0.008, 0.016), M['lamp_rear'], rot=tilt)
    for s in (1, -1):
        sd = V((-s, 0, 0))
        for u0 in (0.06, -1.17):  # door handles near the doors' rear edges: a grip over a dark recess
            at = (s, -u0, 0.89)
            sh.decal('dark', at, sd, rrect(0.17, 0.05, 0.02), off=0.002)
            loc, n = sh.surface(at, sd)
            blob(sh.part('details', at), loc + n * 0.016, (0.026, 0.17, 0.026), M['paint'], r=0.011)
        if lod:  # the distance model has no door gaps: seams instead
            for u0, z0, z1 in ((0.90, 0.33, 0.95), (-0.11, 0.3, 0.99), (-1.33, 0.33, 0.99)):
                sh.decal('dark', (s, -u0, (z0 + z1) / 2), sd, rrect(0.008, z1 - z0, 0.003), off=0.0015)
        # side indicator on the front wing
        sh.decal('indicator', (s, -1.68, 0.78), sd, rrect(0.06, 0.025, 0.012), bulge=0.004)
        # rubbing strip low on the doors and wings
        for u0, u1 in ((0.91, 0.99), (-0.10, 0.89), (-0.86, -0.12)):
            sh.decal('trim', (s, -(u0 + u1) / 2, 0.4), sd, rrect(u1 - u0, 0.05, 0.02), off=0.006)
        mirror(sh.part('details', (s * 0.83, -0.83, 1.0)), {**M, 'glass': M['chrome']}, (s * 0.83, -0.83, 1.0), s)
        if not lod:
            for ua in (S['wb'] / 2, -S['wb'] / 2):
                arch_lip(sh, M, s, ua)
    wipers(p, M, skin, S)
    exhaust(p, M, skin, 0.4, B, r=0.036)
    p.cyl(V((0.0, 1.3, 1.445)), V((0.0, 1.52, 1.56)), 0.005, M['trim'], seg=5)  # antenna at the rear of the roof
    if not lod:
        build_interior(sh, LAYOUT)
    sh.finish()

    ua, x = S['wb'] / 2, S['track'] / 2
    for name, (sx, su) in {'wheel_fl': (1, ua), 'wheel_fr': (-1, ua), 'wheel_rl': (1, -ua), 'wheel_rr': (-1, -ua)}.items():
        wheel(name, M, S, sx, coll, body, (sx * x, -su, S['r']))
    for name, c in (('light_fl', hl[0]), ('light_fr', hl[1]), ('tail_l', tl[0]), ('tail_r', tl[1])):
        empty(coll, name, c if c is not None else V((0, 0, 0)), body)
    return body, S, sh


def arch_lip(sh, M, s, ua):
    """A rolled lip round the wheel arch on side s at axle u = ua, split between the body and the door it crosses."""
    cz, R = S['r'] + 0.012, S['r'] + 0.035 + 0.014
    runs, last = [], None
    for i in range(33):
        a = math.radians(8 + 164 * i / 32)
        dy, dz = math.cos(a), math.sin(a)
        loc, _ = sh.surface((s, -ua + (R + 0.02) * dy, cz + (R + 0.02) * dz), (-s, 0, 0))
        if loc is None:
            last = None
            continue
        pt = V((loc.x - s * 0.006, -ua + R * dy, cz + R * dz))
        t = sh.target(-pt.y, pt.x)
        if t != last:
            runs.append((pt, []))
            last = t
        runs[-1][1].append(pt)
    for at, pts in runs:
        if len(pts) > 1:
            sh.part('details', at).tube(pts, 0.016, M['paint'], seg=8)


def review(shot, sh):
    """Interior stills: 'cut' from above with the roof clipped away, 'seated' with a manikin on every seat."""
    out = [shot('cut', (0, 0.1, 6.0), (0, 0.1, 0), ortho=4.6, clip=6.0 - 1.06)]
    seat_manikins(sh, LAYOUT)
    out.append(shot('seated-side', (5.2, 0.2, 1.05), (0, 0.2, 0.85), lens=60))
    out.append(shot('seated-front', (-0.9, -4.6, 1.45), (0, 0, 0.95), lens=55))
    sh.doors['door_fl'].rotation_euler.z = -1.13
    out.append(shot('seated', (3.6, -3.2, 1.9), (0.2, 0, 0.8), lens=45))
    sh.doors['door_fl'].rotation_euler.z = 0
    return out


if __name__ == '__main__':
    run2(NAME, HERE, build, review)
