"""Kleinwagen: five-door compact hatchback (≈ 4.05 × 1.75 × 1.46 m, wheelbase 2.55 m, 185/65 R15).

Run headless:  blender -b --factory-startup --python data/models/cars/kleinwagen/build.py
Conventions: ../README.md.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carbody import V, build_lod_shell, build_shell, car_materials2, run2  # noqa: E402
from carinterior import build_interior, seat_manikins  # noqa: E402
from carparts import empty, exhaust, lamp_pair, mirror, poly_round, rrect, wheel, wipers  # noqa: E402

NAME = 'kleinwagen'
F, B = 2.075, -1.975  # u of the front and rear faces

S = dict(
    wb=2.55, track=1.50, r=0.305, rim_r=0.195, tyre_w=0.185, spokes=5, double_spokes=True,
    front=F, rear=B,
    top=[(B, 1.0), (-1.95, 1.05), (-1.82, 1.25), (-1.7, 1.39), (-1.55, 1.425), (-1.0, 1.45), (-0.3, 1.46), (0.25, 1.43),
         (0.62, 1.22), (0.95, 0.985), (1.45, 0.905), (1.9, 0.825), (2.03, 0.775), (F, 0.72)],
    belt=[(B, 0.98), (-1.6, 0.975), (-1.2, 0.955), (0.95, 0.915), (1.5, 0.87), (2.0, 0.76), (F, 0.70)],
    bottom=[(B, 0.42), (-1.8, 0.26), (-1.2, 0.19), (1.3, 0.19), (1.85, 0.26), (F, 0.34)],
    width=[(B, 0.79), (-1.9, 0.855), (-1.72, 0.875), (1.6, 0.875), (1.88, 0.845), (2.02, 0.79), (F, 0.71)],
    topw=[(B, 0.71), (-1.9, 0.69), (-1.6, 0.66), (0.25, 0.655), (0.95, 0.77), (1.5, 0.79), (1.9, 0.75), (F, 0.62)],
    widest=0.42,
    screen=(0.95, 0.25),
    topglass=[(0.93, 0.27), (-1.72, -1.94)],
    side=[(0.86, -0.06), (-0.16, -1.42)],
    extra=[1.275, -1.275, 0.0],
    step=0.15,
)


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
    panels={'door_fl': (-0.07, 0.8), 'door_fr': (-0.07, 0.8), 'door_rl': (-0.98, -0.15), 'door_rr': (-0.98, -0.15)},
)


def build(coll, lod=False):
    M = car_materials2((0.08, 0.22, 0.5))
    sh = build_lod_shell(S, M, coll) if lod else build_shell(S, M, coll, DOORS)
    body, skin = sh.body, sh.skin
    d = sh.part('decals')
    # headlamps: swept wedges wrapping the front corners
    head = poly_round([(-0.17, -0.045), (0.12, -0.05), (0.2, 0.0), (0.19, 0.055), (-0.17, 0.035)], 0.025)
    hl = lamp_pair(d, skin, M, 'lamp_front', F, 0.6, 0.715, head, d_side=0.45)
    # grille between the lamps, lower intake, plate
    sh.decal('trim', (0, -F, 0.715), (0, 1, 0), rrect(0.66, 0.07, 0.03), bulge=0.002)
    sh.decal('trim', (0, -F, 0.47), (0, 1, 0), poly_round([(-0.5, -0.09), (0.5, -0.09), (0.44, 0.08), (-0.44, 0.08)], 0.04), bulge=0.003)
    sh.decal('plate', (0, -F, 0.47), (0, 1, 0), rrect(0.52, 0.11, 0.01), off=0.012)
    sh.decal('plate_eu', (0.235, -F, 0.47), (0, 1, 0), rrect(0.045, 0.1, 0.005), off=0.014)
    for s in (1, -1):  # fog lamps
        sh.decal('lamp_front', (s * 0.62, -F, 0.42), (-s * 0.3, 1, 0), rrect(0.11, 0.05, 0.02), bulge=0.004)
    # rear: tall tail lamps at the corners, plate in the tailgate, reflector strip
    tail = poly_round([(-0.09, -0.08), (0.12, -0.08), (0.12, 0.09), (-0.05, 0.09)], 0.025)
    tl = lamp_pair(d, skin, M, 'lamp_rear', B, 0.68, 0.88, tail, d_side=0.5, front=False)
    sh.decal('trim', (0, -B, 0.36), (0, -1, 0), poly_round([(-0.8, -0.1), (0.8, -0.1), (0.78, 0.06), (-0.78, 0.06)], 0.05), off=0.003)
    sh.decal('plate', (0, -B, 0.72), (0, -1, 0), rrect(0.52, 0.11, 0.01), off=0.008)
    sh.decal('plate_eu', (-0.235, -B, 0.72), (0, -1, 0), rrect(0.045, 0.1, 0.005), off=0.01)
    sh.decal('trim', (0, -B, 0.97), (0, -1, 0), rrect(1.1, 0.012, 0.004), off=0.003)  # tailgate seam
    for s in (1, -1):
        sd = V((-s, 0, 0))
        for u0 in (0.06, -1.17):  # door handles near the doors' rear edges
            sh.decal('trim', (s, -u0, 0.89), sd, rrect(0.16, 0.03, 0.012), off=0.004, bulge=0.008)
        if lod:  # the distance model has no door gaps: seams instead
            for u0, z0, z1 in ((0.90, 0.33, 0.95), (-0.11, 0.3, 0.99), (-1.33, 0.33, 0.99)):
                sh.decal('dark', (s, -u0, (z0 + z1) / 2), sd, rrect(0.008, z1 - z0, 0.003), off=0.0015)
        # side indicator on the front wing
        sh.decal('indicator', (s, -1.68, 0.78), sd, rrect(0.06, 0.025, 0.012), bulge=0.004)
        # rubbing strip low on the doors and wings
        for u0, u1 in ((0.91, 0.99), (-0.10, 0.89), (-0.86, -0.12)):
            sh.decal('trim', (s, -(u0 + u1) / 2, 0.4), sd, rrect(u1 - u0, 0.05, 0.02), off=0.006)
        mirror(sh.part('details', (s * 0.83, -0.83, 1.0)), {**M, 'glass': M['chrome']}, (s * 0.83, -0.83, 1.0), s)
    p = sh.part('details')
    wipers(p, M, skin, S)
    exhaust(p, M, skin, 0.4, B, r=0.036)
    p.cyl(V((0.0, 0.0, 1.47)), V((0.0, 0.35, 1.52)), 0.006, M['trim'], seg=5)  # antenna
    if not lod:
        build_interior(sh, LAYOUT)
    sh.finish()

    ua, x = S['wb'] / 2, S['track'] / 2
    for name, (sx, su) in {'wheel_fl': (1, ua), 'wheel_fr': (-1, ua), 'wheel_rl': (1, -ua), 'wheel_rr': (-1, -ua)}.items():
        wheel(name, M, S, sx, coll, body, (sx * x, -su, S['r']))
    for name, c in (('light_fl', hl[0]), ('light_fr', hl[1]), ('tail_l', tl[0]), ('tail_r', tl[1])):
        empty(coll, name, c if c is not None else V((0, 0, 0)), body)
    return body, S, sh


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
