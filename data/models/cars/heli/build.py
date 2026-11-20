"""Helicopter: a light two-seater on skids (cabin ≈ 4.2 × 1.7 × 2.1 m, three-blade main rotor Ø 8.8 m).

Flown like a car is driven (CAR_SPECS.heli, CAR_SEATS.heli); it has no wheel nodes, but `rotor_main` (spins about the
vertical) and `rotor_tail` (spins about X).

Run headless:  blender -b --factory-startup --python data/models/cars/heli/build.py
Conventions: ../README.md.
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from carbody import car_materials2, setup_render, shoot  # noqa: E402
from carinterior import blob, bucket_seat, steering_wheel  # noqa: E402
from carparts import Part, clear_scene, empty, export_car, make_lod  # noqa: E402

V = Vector
NAME = 'heli'
N = 32  # points of a fuselage ring

# fuselage sections: u (m ahead of the origin), centre height, half height, half width
SECTIONS = [
    (2.4, 0.95, 0.10, 0.12), (2.3, 0.95, 0.30, 0.34), (2.1, 0.97, 0.46, 0.52), (1.8, 1.02, 0.58, 0.68), (1.3, 1.11, 0.71, 0.82),
    (0.5, 1.2, 0.8, 0.85), (0.1, 1.21, 0.8, 0.85), (-0.3, 1.22, 0.8, 0.84), (-1.0, 1.3, 0.68, 0.7), (-1.6, 1.4, 0.45, 0.44),
    (-2.2, 1.45, 0.26, 0.24), (-4.5, 1.5, 0.17, 0.15), (-6.7, 1.55, 0.11, 0.09),
]
DOOR_U = (0.1, 1.3)  # rear edge, hinge (CAR_SEATS.heli)
HINGE_X = 0.84
SEATS = [(0.4, 0.5, 0.85), (-0.4, 0.5, 0.85)]
FLOOR = 0.5
MAST = 2.55  # height of the main rotor


def section(u):
    """(centre z, half height, half width) at u: the table, smoothly interpolated."""
    s = SECTIONS
    for a, b in zip(s, s[1:]):
        if a[0] >= u >= b[0]:
            t = (a[0] - u) / (a[0] - b[0])
            t = t * t * (3 - 2 * t)
            return tuple(a[k] + (b[k] - a[k]) * t for k in (1, 2, 3))
    return s[0][1:] if u > s[0][0] else s[-1][1:]


def ring_point(u, k):
    """Point k of the ring at u (k = 0 at the bottom centre, going up the left side): a rounded-box cross-section."""
    cz, hh, hw = section(u)
    a = 2 * math.pi * k / N
    sx, sz = math.sin(a), -math.cos(a)
    e = 0.72  # < 1: squarer than an ellipse
    return V((hw * math.copysign(abs(sx) ** e, sx), -u, cz + hh * math.copysign(abs(sz) ** e, sz)))


def stations():
    us = {round(s[0], 3) for s in SECTIONS} | set(DOOR_U) | {0.9}
    u = SECTIONS[0][0]
    while u > SECTIONS[-1][0]:
        us.add(round(u, 3))
        u -= 0.1 if u > -2.2 else 0.55
    return sorted(us, reverse=True)


def face_kind(u, k):
    """What the skin face between ring points k, k+1 just behind u is: 'door_l', 'door_r' or a material name."""
    cz, hh, _ = section(u - 0.05)
    z = (ring_point(u - 0.05, k).z + ring_point(u - 0.05, k + 1).z) / 2
    rel = (z - cz) / hh  # −1 bottom … 1 top
    side = 1 if k < N // 2 else -1
    in_door = DOOR_U[0] <= u - 0.05 <= DOOR_U[1] and -0.62 < rel < 0.78
    if in_door:
        return ('door_l' if side > 0 else 'door_r'), ('glass' if rel > -0.02 else 'paint')
    if u - 0.05 > 1.3 and rel > -0.3:
        return 'body', 'glass'  # the bubble
    if 0.9 < u - 0.05 <= 1.3 and rel > 0.78:
        return 'body', 'glass'  # roof window over the seats' front
    return 'body', 'paint'


def fuselage(coll, M, lod):
    parts = {'body': Part('body'), 'door_l': Part('door_fl'), 'door_r': Part('door_fr')}
    origin = {'body': V((0, 0, 0)), 'door_l': V((HINGE_X, -DOOR_U[1], 0)), 'door_r': V((-HINGE_X, -DOOR_U[1], 0))}
    us = stations()
    cache = {}

    def vert(name, i, k):
        key = (name, i, k % N)
        if key not in cache:
            cache[key] = parts[name].bm.verts.new(ring_point(us[i], k % N) - origin[name])
        return cache[key]

    for i in range(len(us) - 1):
        for k in range(N):
            name, mat = face_kind(us[i], k)
            if lod and mat == 'glass':
                mat = 'glass_dark'
            parts[name]._face([vert(name, i, k), vert(name, i, k + 1), vert(name, i + 1, k + 1), vert(name, i + 1, k)], M[mat], True)
    body = parts['body']
    for i, mat in ((0, 'glass_dark' if lod else 'glass'), (len(us) - 1, 'paint')):
        body._face([vert('body', i, k) for k in range(N)], M[mat], True)
    return body, parts['door_l'], parts['door_r']


def details(body, M):
    # engine cowling on the roof and the mast
    blob(body, (0, 0.55, 2.02), (0.9, 1.9, 0.42), M['paint'], r=0.16, seg=4)
    blob(body, (0, 1.75, 1.75), (0.5, 0.9, 0.34), M['paint'], r=0.12, seg=4)
    body.cyl(V((0, 0, 2.1)), V((0, 0, MAST - 0.04)), 0.07, M['rim_dark'], seg=16)
    for s in (1, -1):  # exhaust stubs
        body.cyl(V((s * 0.3, 1.45, 2.0)), V((s * 0.42, 1.75, 2.08)), 0.06, M['rim_dark'], seg=12)
    # skids: two tubes turned up at the front, on two cross tubes bent down from the belly
    for s in (1, -1):
        x = s * 1.0
        body.tube([V((x, 1.55, 0.05)), V((x, -1.35, 0.05)), V((x, -1.75, 0.16)), V((x, -1.95, 0.34))], 0.045, M['rim_dark'], seg=12)
    for y in (-0.85, 0.85):
        body.tube([V((-1.0, y, 0.07)), V((-0.72, y, 0.4)), V((0, y, 0.5)), V((0.72, y, 0.4)), V((1.0, y, 0.07))], 0.038, M['rim_dark'], seg=12)
    # tail: fin, stabiliser, guard under the fin
    fin = Matrix.Rotation(math.radians(24), 3, 'X')
    blob(body, (0, 6.55, 1.95), (0.07, 0.62, 1.3), M['paint'], fin, r=0.03)
    blob(body, (0, 6.45, 1.15), (0.06, 0.4, 0.62), M['paint'], Matrix.Rotation(math.radians(-30), 3, 'X'), r=0.025)
    blob(body, (0, 5.5, 1.52), (1.7, 0.42, 0.05), M['paint'], r=0.02)
    for s in (1, -1):
        blob(body, (s * 0.85, 5.5, 1.56), (0.05, 0.5, 0.4), M['paint'], r=0.02)
    body.cyl(V((0, 6.5, 1.6)), V((0.2, 6.5, 1.6)), 0.05, M['rim_dark'], seg=12)  # tail rotor gearbox
    # landing lights under the nose, a red lamp at the very tail
    for s in (1, -1):
        body.cyl(V((s * 0.3, -2.17, 0.66)), V((s * 0.3, -2.25, 0.63)), 0.075, M['lamp_front'], seg=16)
    blob(body, (0, 6.78, 1.56), (0.09, 0.08, 0.09), M['lamp_rear'], r=0.03)


def door_details(door, M, side):
    x = side * 0.012
    blob(door, (x, DOOR_U[1] - DOOR_U[0] - 0.14, 1.12), (0.03, 0.12, 0.035), M['chrome'], r=0.012)  # handle near the rear edge


def interior(coll, M, body):
    p = Part('interior')
    p.box(V((0, -0.6, FLOOR - 0.02)), (1.1, 1.9, 0.04), M['interior'])  # floor
    blob(p, (0, 0.42, 1.2), (1.5, 0.06, 1.4), M['interior_trim'], r=0.02)  # bulkhead behind the seats
    blob(p, (0, -1.5, 0.95), (1.0, 0.3, 0.5), M['interior'], Matrix.Rotation(math.radians(-18), 3, 'X'), r=0.07)  # instrument panel
    blob(p, (0, -1.38, 1.2), (0.7, 0.05, 0.22), M['dark'], Matrix.Rotation(math.radians(-18), 3, 'X'), r=0.015)  # its glass
    blob(p, (0, -1.0, 0.62), (0.26, 1.0, 0.26), M['interior_trim'], r=0.05)  # centre console
    for x, u, h in SEATS:
        bucket_seat(p, M, x, u, h, w=0.48, floor=FLOOR)
    for s in (1, -1):  # pedals
        for dx in (-0.1, 0.1):
            p.box(V((s * 0.4 + dx, -1.55, FLOOR + 0.12)), (0.08, 0.03, 0.14), M['interior_trim'])
    ob = p.to_object(coll, body)
    return ob


def rotor(coll, M, body):
    p = Part('rotor_main')
    p.cyl(V((0, 0, -0.06)), V((0, 0, 0.1)), 0.16, M['rim_dark'], seg=20)
    for i in range(3):
        rot = Matrix.Rotation(2 * math.pi * i / 3, 3, 'Z')
        blob(p, rot @ V((0, 0.45, 0.02)), (0.1, 0.7, 0.06), M['rim_dark'], rot, r=0.02)  # blade grip
        blob(p, rot @ V((0, 2.55, 0.02)), (0.3, 3.7, 0.035), M['dark'], rot @ Matrix.Rotation(math.radians(4), 3, 'Y'), r=0.012)
        blob(p, rot @ V((0, 4.3, 0.02)), (0.3, 0.2, 0.036), M['indicator'], rot @ Matrix.Rotation(math.radians(4), 3, 'Y'), r=0.012)  # tip mark
    main = p.to_object(coll, body, (0, 0, MAST))

    t = Part('rotor_tail')
    t.cyl(V((-0.03, 0, 0)), V((0.05, 0, 0)), 0.07, M['rim_dark'], seg=14)
    for i in range(2):
        rot = Matrix.Rotation(math.pi * i, 3, 'X')
        blob(t, rot @ V((0.02, 0, 0.42)), (0.025, 0.13, 0.72), M['dark'], rot, r=0.01)
    tail = t.to_object(coll, body, (0.24, 6.5, 1.6))
    return main, tail


def build(coll, lod):
    M = car_materials2((0.9, 0.62, 0.05))
    body_p, dl, dr = fuselage(coll, M, lod)
    details(body_p, M)
    body = body_p.to_object(coll)
    door_details(dl, M, 1)
    door_details(dr, M, -1)
    doors = {
        'door_fl': dl.to_object(coll, body, (HINGE_X, -DOOR_U[1], 0)),
        'door_fr': dr.to_object(coll, body, (-HINGE_X, -DOOR_U[1], 0)),
    }
    interior(coll, M, body)
    steering_wheel(coll, M, body, dict(x=SEATS[0][0], u=1.12, z=1.02, rake=0.5, r=0.13))
    rotor(coll, M, body)
    for i, (x, u, h) in enumerate(SEATS):
        empty(coll, f'seat_{i}', (x, -u, h), body)
    empty(coll, 'light_fl', (0.3, -2.25, 0.63), body)
    empty(coll, 'light_fr', (-0.3, -2.25, 0.63), body)
    empty(coll, 'tail_l', (0.05, 6.8, 1.56), body)
    empty(coll, 'tail_r', (-0.05, 6.8, 1.56), body)
    return body, doors


def tris(root):
    return sum(len(p.vertices) - 2 for o in [root, *root.children_recursive] if o.type == 'MESH' for p in o.data.polygons)


def run():
    clear_scene()
    coll = bpy.data.collections.new('CAR_HELI')
    bpy.context.scene.collection.children.link(coll)
    root, doors = build(coll, False)
    full = tris(root)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'))
    export_car(os.path.join(HERE, f'{NAME}.glb'), root)

    repo = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
    out = os.path.join(repo, 'shots', 'cars')
    os.makedirs(out, exist_ok=True)
    cam = setup_render()
    shots = [
        shoot(cam, os.path.join(out, 'heli-34.png'), V((-7.5, -9.5, 4.0)), (0, 1.5, 1.2)),
        shoot(cam, os.path.join(out, 'heli-side.png'), V((-13.0, 2.0, 1.6)), (0, 2.0, 1.3)),
        shoot(cam, os.path.join(out, 'heli-rear.png'), V((6.5, 11.0, 3.6)), (0, 1.5, 1.2)),
    ]
    for name, ob in doors.items():
        ob.rotation_euler.z = -(1 if name == 'door_fl' else -1) * 1.13
    shots.append(shoot(cam, os.path.join(out, 'heli-open.png'), V((4.5, -5.0, 2.4)), (0, -0.6, 1.0), lens=40))

    clear_scene()
    coll = bpy.data.collections.new('CAR_HELI_LOD')
    bpy.context.scene.collection.children.link(coll)
    root, _ = build(coll, True)
    lod = make_lod(root, ratio=0.3)
    export_car(os.path.join(HERE, f'{NAME}_lod.glb'), root)
    print('CAR_REPORT', NAME, dict(tris=full, lod_tris=lod, shots=shots))


run()
