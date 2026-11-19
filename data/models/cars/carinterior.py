"""Car interiors as seen through the glass from outside: floor, firewall, dashboard, steering wheel, seats, console,
door panels – and the nodes the game seats its figures on (run inside Blender; frame as in carparts.py / README.md).

Everything is placed from a `layout` dict in metres (u = ahead of the origin, x = to the left, z = above the ground):

    seats      [(x, u, h), ...] hip points, driver first, then front passenger, rear left, rear right
    front      number of front seats (bucket seats); the rest share a bench
    wheel      {'x', 'u', 'z', 'rake', 'r'}: steering wheel hub, column angle above the horizontal (rad), rim radius
    floor      z of the floor
    half_w     half the cabin width at the door panels
    firewall   u of the firewall
    dash       {'u0': rear face, 'top': z of the top}
    shelf      {'u0', 'u1', 'z'}: cover behind the rear seats, or None
    mirror     (u, z) of the inner mirror
    panels     {'door_fl': (u0, u1), ...}: extent of each door's inner panel
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from carparts import Part, empty

V = Vector
RX = lambda a: Matrix.Rotation(a, 3, 'X')  # noqa: E731

RECLINE_FRONT, RECLINE_REAR = math.radians(22), math.radians(25)


def blob(part, c, size, mat, rot=None, r=0.03, seg=3, shape=None):
    """A box with rounded edges (smooth shaded): centre c, size (x, y, z), optional rotation about its centre.
    shape(co) may reshape it in its own frame before it is placed."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = V((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(r, min(size) / 2.2), segments=seg, profile=0.5, affect='EDGES')
    c = V(c)
    vmap = {}
    for v in bm.verts:
        co = v.co.copy()
        if shape:
            co = shape(co)
        if rot:
            co = rot @ co
        vmap[v] = part.bm.verts.new(c + co)
    for f in bm.faces:
        part._face([vmap[v] for v in f.verts], mat, True)
    bm.free()


def taper(size, top=0.85, axis=2):
    """Shape for blob: narrows x towards +axis to `top` of the width."""
    def f(co):
        k = 0.5 + co[axis] / size[axis]
        return V((co.x * (1 + (top - 1) * k), co.y, co.z))
    return f


def bucket_seat(p, M, x, u, h, recline=RECLINE_FRONT, w=0.5):
    """A front seat round the hip point (x, u, h): cushion with side bolsters, shaped backrest, headrest on stalks."""
    y = -u
    top = h - 0.09  # cushion surface under the hip point
    p.box(V((x, y - 0.17, top - 0.2)), (w * 0.8, 0.42, 0.1), M['interior'])  # base and rails
    blob(p, (x, y - 0.19, top - 0.055), (w, 0.52, 0.13), M['seat'], RX(math.radians(-7)), r=0.045)
    for s in (1, -1):
        blob(p, (x + s * (w / 2 - 0.035), y - 0.17, top - 0.01), (0.09, 0.46, 0.1), M['seat'], RX(math.radians(-7)), r=0.04)
    back = RX(-recline)
    foot = V((x, y + 0.14, top - 0.02))  # where the backrest meets the cushion
    size = (w - 0.02, 0.11, 0.68)
    blob(p, foot + back @ V((0, 0, 0.34)), size, M['seat'], back, r=0.045, shape=taper(size, 0.84))
    for s in (1, -1):
        blob(p, foot + back @ V((s * (w / 2 - 0.05), -0.035, 0.27)), (0.08, 0.1, 0.46), M['seat'], back, r=0.035)
    head = foot + back @ V((0, -0.04, 0.85))
    for s in (1, -1):
        p.cyl(foot + back @ V((s * 0.07, 0, 0.64)), head + V((s * 0.07, 0, 0)), 0.008, M['rim_dark'], seg=6)
    blob(p, head, (0.27, 0.11, 0.19), M['seat'], back, r=0.045)


def bench(p, M, seats, recline=RECLINE_REAR, w=1.3):
    """A rear bench for the two outer seats: one cushion, one backrest, a headrest behind each seat."""
    u = sum(s[1] for s in seats) / len(seats)
    h = sum(s[2] for s in seats) / len(seats)
    y, top = -u, h - 0.09
    p.box(V((0, y - 0.15, top - 0.2)), (w, 0.5, 0.14), M['interior'])
    blob(p, (0, y - 0.17, top - 0.055), (w, 0.52, 0.14), M['seat'], RX(math.radians(-8)), r=0.05)
    back = RX(-recline)
    foot = V((0, y + 0.15, top - 0.02))
    blob(p, foot + back @ V((0, 0, 0.33)), (w - 0.08, 0.11, 0.66), M['seat'], back, r=0.05)
    for x, _, _ in seats:
        head = foot + back @ V((x, -0.04, 0.8))
        for s in (1, -1):
            p.cyl(foot + back @ V((x + s * 0.07, 0, 0.62)), head + V((s * 0.07, 0, 0)), 0.008, M['rim_dark'], seg=6)
        blob(p, head, (0.26, 0.1, 0.17), M['seat'], back, r=0.04)


def steering_wheel(coll, M, body, wh):
    """Node 'steering' at the hub, its local Z along the column (towards the driver), with grip_l / grip_r on the rim."""
    p = Part('steering')
    R, r = wh['r'], 0.015
    seg, rseg = 32, 8
    rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for j in range(rseg):
            b = 2 * math.pi * j / rseg
            ring.append(p.bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b))))
        rings.append(ring)
    for i in range(seg):
        for j in range(rseg):
            a, b = rings[i], rings[(i + 1) % seg]
            p._face([a[j], b[j], b[(j + 1) % rseg], a[(j + 1) % rseg]], M['interior'], True)
    blob(p, (0, 0, -0.02), (0.13, 0.11, 0.06), M['interior_trim'], r=0.025)  # hub pad
    for ang in (0.0, math.pi, -math.pi / 2):  # spokes: left, right, down
        d = V((math.cos(ang), math.sin(ang), 0))
        blob(p, d * (R / 2 + 0.02) + V((0, 0, -0.02)), (R - 0.04, 0.035, 0.022), M['interior_trim'], Matrix.Rotation(ang, 3, 'Z'), r=0.01)
    p.cyl(V((0, 0, -0.04)), V((0, 0, -0.3)), 0.028, M['interior'], seg=10)  # column into the dashboard
    ob = p.to_object(coll)
    ob.parent = body
    ob.location = (wh['x'], -wh['u'], wh['z'])
    ob.rotation_euler = (-(math.pi / 2 - wh['rake']), 0, 0)
    empty(coll, 'grip_l', (R, 0, 0), ob)
    empty(coll, 'grip_r', (-R, 0, 0), ob)
    return ob


def build_interior(sh, layout):
    """Adds the interior to shell sh (before sh.finish()): mesh 'interior', node 'steering' with its grips, the seat
    nodes seat_<n>, and an inner panel on every door. Returns the interior object."""
    M, coll, body, L = sh.M, sh.coll, sh.body, layout
    p = Part('interior')
    hw, fl, fw = L['half_w'], L['floor'], L['firewall']
    # carpet (inside the sills, between the axles' wheel housings), tunnel, firewall
    rear = -sh.S['wb'] / 2 + 0.25
    p.box(V((0, -(fw + rear) / 2, fl + 0.006)), (2 * hw - 0.18, fw - rear, 0.012), M['interior'])
    blob(p, (0, -(fw - 0.75), fl + 0.07), (0.2, 1.5, 0.14), M['interior'], r=0.04)
    p.box(V((0, -fw, (fl + L['dash']['top']) / 2)), (2 * hw, 0.03, L['dash']['top'] - fl), M['interior'])
    # dashboard: a deep upper body under the windscreen, a shallower lower part, the instrument hood, vents
    d0, dt = L['dash']['u0'], L['dash']['top']
    blob(p, (0, -(d0 + fw) / 2, dt - 0.09), (2 * hw, fw - d0, 0.18), M['interior'], RX(math.radians(4)), r=0.05)
    blob(p, (0, -(d0 + 0.1 + fw) / 2, dt - 0.26), (2 * hw, fw - d0 - 0.1, 0.22), M['interior_trim'], r=0.04)
    wh = L['wheel']
    blob(p, (wh['x'], -(d0 + 0.07), dt + 0.015), (0.36, 0.2, 0.07), M['interior'], RX(math.radians(-6)), r=0.03)
    p.box(V((wh['x'], -(d0 - 0.002), dt - 0.05)), (0.26, 0.004, 0.07), M['dark'])  # instrument cluster
    blob(p, (0, -(d0 - 0.005), dt - 0.16), (0.24, 0.02, 0.2), M['interior_trim'], r=0.008)  # centre stack
    p.box(V((0, -(d0 - 0.017), dt - 0.11)), (0.19, 0.004, 0.07), M['dark'])  # radio / screen
    for x in (-hw + 0.14, -0.2, 0.2, hw - 0.14):  # air vents
        p.box(V((x, -(d0 - 0.002), dt - 0.07)), (0.1, 0.004, 0.045), M['dark'])
    blob(p, (-wh['x'], -(d0 - 0.003), dt - 0.24), (0.34, 0.01, 0.13), M['interior'], r=0.005)  # glove box lid
    # centre console with gear lever and handbrake
    blob(p, (0, -(d0 - 0.42), fl + 0.15), (0.2, 0.84, 0.2), M['interior_trim'], r=0.04)
    gl = V((0, -(d0 - 0.22), fl + 0.25))
    p.cyl(gl, gl + V((0, 0.02, 0.13)), 0.009, M['chrome'], seg=6)
    blob(p, gl + V((0, 0.02, 0.15)), (0.045, 0.05, 0.05), M['interior'], r=0.02)
    hb = V((0.0, -(d0 - 0.62), fl + 0.26))
    blob(p, hb, (0.035, 0.22, 0.035), M['interior'], RX(math.radians(12)), r=0.015)
    # seats
    for x, u, h in L['seats'][:L['front']]:
        bucket_seat(p, M, x, u, h)
    if len(L['seats']) > L['front']:
        bench(p, M, L['seats'][L['front']:])
    if L.get('shelf'):
        s = L['shelf']
        p.box(V((0, -(s['u0'] + s['u1']) / 2, s['z'])), (2 * hw, abs(s['u0'] - s['u1']), 0.025), M['interior'])
    if L.get('mirror'):
        mu, mz = L['mirror']
        p.cyl(V((0, -mu - 0.05, mz + 0.06)), V((0, -mu, mz)), 0.008, M['interior'], seg=6)
        blob(p, (0, -mu, mz), (0.22, 0.03, 0.065), M['interior'], r=0.012)
    ob = p.to_object(coll)
    ob.parent = body
    steering_wheel(coll, M, body, wh)
    for i, (x, u, h) in enumerate(L['seats']):
        empty(coll, f'seat_{i}', (x, -u, h), body)
    # door panels: trim board, armrest with a grip, a pocket low down
    for name, (u0, u1) in L.get('panels', {}).items():
        if name not in sh.doors:
            continue
        s = sh.specs[name]['side']
        x = s * (hw - 0.012)
        dp = sh.part('details', (s * 0.8, -(u0 + u1) / 2, 0.6))
        n = u1 - u0
        blob(dp, (x, -(u0 + u1) / 2, 0.61), (0.035, n, 0.6), M['interior_trim'], r=0.015)
        blob(dp, (x - s * 0.04, -(u0 + u1) / 2 + 0.03, 0.66), (0.075, n * 0.62, 0.06), M['interior'], r=0.025)
        blob(dp, (x - s * 0.03, -(u0 + u1) / 2 - 0.02, 0.4), (0.05, n * 0.7, 0.13), M['interior'], r=0.02)
        dp.box(V((x - s * 0.02, -(u0 + n * 0.2), 0.76)), (0.012, 0.1, 0.025), M['chrome'])  # inner handle
    return ob


# ---------------------------------------------------------------- review manikin (never exported)

def two_bone(a, t, l1, l2, pole):
    """Middle joint of a two-bone chain from a to t (segment lengths l1, l2), bent towards `pole`."""
    d = t - a
    n = min(d.length, l1 + l2 - 1e-4)
    d.normalize()
    k = (l1 * l1 - l2 * l2 + n * n) / (2 * n)
    h = math.sqrt(max(l1 * l1 - k * k, 0.0))
    side = pole - d * pole.dot(d)
    if side.length < 1e-6:
        side = V((0, 0, -1))
    return a + d * k + side.normalized() * h


def manikin(coll, M, seat, floor, recline, grips=None, name='manikin'):
    """A seated figure of 1.78 m on hip point seat = (x, u, h): feet on the floor ahead, hands on the grips (world
    points) or on the thighs. For the review stills only."""
    x, u, h = seat
    hip = V((x, -u, h))
    p = Part(name)
    mat = M['manikin']
    back = RX(-recline)
    neck = hip + back @ V((0, 0, 0.5))
    head = neck + RX(-recline * 0.4) @ V((0, 0, 0.2))
    p.tube([hip, neck], 0.12, mat, seg=12)
    blob(p, (hip + neck) / 2, (0.36, 0.2, 0.5), mat, back, r=0.09)
    blob(p, head, (0.16, 0.2, 0.24), mat, RX(-recline * 0.4), r=0.075)
    for s in (1, -1):
        hj = hip + V((s * 0.09, 0, 0))
        knee = hj + V((s * 0.03, -0.43 * math.cos(math.radians(12)), 0.43 * math.sin(math.radians(12))))
        drop = knee.z - (floor + 0.09)
        ankle = knee + V((0, -math.sqrt(max(0.45 ** 2 - drop ** 2, 0.0)), -drop))
        p.tube([hj, knee], 0.075, mat, seg=10)
        p.tube([knee, ankle], 0.055, mat, seg=10)
        blob(p, ankle + V((0, -0.08, -0.04)), (0.1, 0.26, 0.09), mat, r=0.03)
        sh_ = neck + V((s * 0.19, 0, -0.04))
        hand = V(grips[0 if s > 0 else 1]) if grips else knee + V((0, 0.14, 0.085))
        elbow = two_bone(sh_, hand, 0.29, 0.27, V((s * 0.5, 0, -1)))
        p.tube([sh_, elbow], 0.047, mat, seg=8)
        p.tube([elbow, hand], 0.04, mat, seg=8)
        blob(p, hand, (0.08, 0.1, 0.05), mat, r=0.02)
    ob = p.to_object(coll)
    return ob


def seat_manikins(sh, layout):
    """One manikin per seat (driver's hands on the wheel), in a collection of their own. Returns the objects."""
    from nnmodel import material
    M = {**sh.M, 'manikin': material('manikin', (0.85, 0.45, 0.12), rough=0.7)}
    coll = bpy.data.collections.new('MANIKINS')
    bpy.context.scene.collection.children.link(coll)
    bpy.context.view_layer.update()
    grips = [bpy.data.objects[n].matrix_world.translation.copy() for n in ('grip_l', 'grip_r')]
    out = []
    for i, seat in enumerate(layout['seats']):
        front = i < layout['front']
        out.append(manikin(coll, M, seat, layout['floor'], RECLINE_FRONT if front else RECLINE_REAR,
                           grips if i == 0 else None, f'manikin_{i}'))
    return out
