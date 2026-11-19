"""The loft and the helpers shared by the car models in data/models/cars (run inside Blender, headless is fine).
carbody.py builds the shell with openings, doors and glass on top of this, carinterior.py what is inside.

Frame (see README.md here): metres, Blender Z up, ground z = 0, origin on the ground midway between the axles,
the car faces -Y (glTF: +z), its left is +X. `u` below is the distance forward of the origin (Blender y = -u).

The body is a loft of cross-section rings along the car (one ring per station), smoothed by a Subdivision Surface
modifier (creased along the belt and window lines), with wheel arches cut by a Boolean. Lamps, grilles, plates,
seams and handles are "decals": small patches ray-cast onto the finished body and lifted a few millimetres.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'bikes'))
from nnmodel import material  # noqa: E402
from bikeparts import Part  # noqa: E402

V = Vector


# ---------------------------------------------------------------- materials

def car_materials(paint=(0.55, 0.06, 0.05)):
    """The shared material set; 'paint' is the body colour the client recolours per car."""
    m = {
        'paint': material('paint', paint, rough=0.28, metal=0.45),
        'glass': material('glass', (0.07, 0.09, 0.1), rough=0.05, metal=0.2),
        'trim': material('trim', (0.05, 0.05, 0.055), rough=0.55),
        'chrome': material('chrome', (0.85, 0.86, 0.88), rough=0.12, metal=1.0),
        'tyre': material('tyre', (0.045, 0.045, 0.045), rough=0.85),
        'rim': material('rim', (0.72, 0.73, 0.75), rough=0.3, metal=1.0),
        'rim_dark': material('rim_dark', (0.18, 0.18, 0.19), rough=0.45, metal=0.8),
        'dark': material('dark', (0.02, 0.02, 0.02), rough=0.9),
        'plate': material('plate', (0.9, 0.9, 0.86), rough=0.4),
        'plate_eu': material('plate_eu', (0.05, 0.15, 0.6), rough=0.4),
        'indicator': material('indicator', (0.95, 0.5, 0.05), rough=0.15),
        'lamp_front': material('lamp_front', (0.92, 0.93, 0.95), rough=0.08, metal=0.3),
        'lamp_rear': material('lamp_rear', (0.7, 0.04, 0.03), rough=0.15),
        'tridion': material('tridion', (0.62, 0.63, 0.65), rough=0.3, metal=0.8),
    }
    for name in ('lamp_front', 'lamp_rear'):
        bsdf = m[name].node_tree.nodes['Principled BSDF']
        bsdf.inputs['Emission Color'].default_value = bsdf.inputs['Base Color'].default_value
        bsdf.inputs['Emission Strength'].default_value = 0.0  # the client drives it at night / braking
    return m


# ---------------------------------------------------------------- tables

def tab(t, u):
    """Piecewise-linear lookup in [(u, value), ...] (any order), clamped at the ends."""
    t = sorted(t)
    if u <= t[0][0]:
        return t[0][1]
    for (u0, v0), (u1, v1) in zip(t, t[1:]):
        if u <= u1:
            k = (u - u0) / (u1 - u0) if u1 > u0 else 0
            return v0 + (v1 - v0) * k
    return t[-1][1]


def in_ranges(u, ranges):
    return any(min(a, b) <= u <= max(a, b) for a, b in ranges)


# ---------------------------------------------------------------- body loft

SEG = 8  # segments of a half ring (k0 bottom centre … k8 roof centre)


def ring(S, u):
    """Left half (+X) of the cross-section at u as [(x, z)] k0..k8."""
    w = tab(S['width'], u)
    zb = tab(S['bottom'], u)
    top = tab(S['top'], u)
    belt = min(tab(S['belt'], u), top - 0.05)
    wt = min(tab(S['topw'], u), w - 0.06)
    zm = zb + (belt - zb) * S.get('widest', 0.5)
    z6 = max(belt + 0.03, top - S.get('rail', 0.055))
    return [
        (0.0, zb),
        (w - 0.1, zb),
        (w - 0.01, zb + 0.1),
        (w, zm),
        (w - S.get('shoulder', 0.012), belt),
        (w - S.get('shoulder', 0.012) - 0.022, belt + 0.02),
        (wt + 0.035, z6),
        (wt, top),
        (0.0, top + S.get('crown', 0.025)),
    ]


def stations(S):
    keys = {u for t in ('top', 'belt', 'bottom', 'width', 'topw') for u, _ in S[t]}
    for r in ('side', 'topglass', 'pillars'):
        for a, b in S.get(r, []):
            keys |= {a, b}
    keys |= set(S.get('extra', []))
    lo, hi = S['rear'], S['front']
    keys = sorted(k for k in keys if lo <= k <= hi) + [lo, hi]
    keys = sorted(set(round(k, 4) for k in keys))
    out = []
    for a, b in zip(keys, keys[1:]):
        n = max(1, math.ceil((b - a) / S.get('step', 0.16)))
        out += [a + (b - a) * i / n for i in range(n)]
    return out + [keys[-1]]


def face_material(S, u, seg):
    """Material name of the loft face between stations around u, half-ring segment seg (0 = underside)."""
    if seg == 0:
        return 'dark'
    if seg == 5 and in_ranges(u, S.get('side', [])):
        return 'glass'
    if seg == 7 and in_ranges(u, S.get('topglass', [])):
        return 'glass'
    f = S.get('face_mat')
    if f:
        name = f(u, seg)
        if name:
            return name
    return 'paint'


def body_mesh(S, M, coll):
    """The lofted, capped body cage with creases and per-face materials (no modifiers yet)."""
    bm = bmesh.new()
    crease = bm.edges.layers.float.get('crease_edge') or bm.edges.layers.float.new('crease_edge')
    mats = []

    def mi(name):
        if M[name] not in mats:
            mats.append(M[name])
        return mats.index(M[name])

    us = stations(S)
    rings = []
    for u in us:
        half = ring(S, u)
        loop = half + [(-x, z) for x, z in reversed(half[1:-1])]  # k0..k8, k7'..k1'
        rings.append([bm.verts.new((x, -u, z)) for x, z in loop])
    n = len(rings[0])
    # segment index of loop edge j (j → j+1) in the half ring
    seg_of = [j if j < SEG else (2 * SEG - 1 - j) for j in range(n)]
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        um = (us[i] + us[i + 1]) / 2
        for j in range(n):
            k = (j + 1) % n
            f = bm.faces.new([a[j], a[k], b[k], b[j]])
            f.material_index = mi(face_material(S, um, seg_of[j]))
            f.smooth = True
    # longitudinal creases
    cre = S.get('creases', {2: 0.5, 4: 0.7, 5: 0.5, 6: 0.8, 7: 0.8})
    bm.edges.ensure_lookup_table()
    for i in range(len(rings) - 1):
        for j, c in cre.items():
            for jj in (j, (n - j) % n):
                e = bm.edges.get([rings[i][jj], rings[i + 1][jj]])
                if e:
                    e[crease] = c
    # caps: an inner ring (smaller, a bit outward) and an n-gon, so the subdivided fascia stays tidy
    for end, sign in ((0, 1), (-1, -1)):
        r = rings[end]
        cx = 0.0
        cz = sum(v.co.z for v in r) / n
        u_end = us[end]
        out = 1 if end == 0 else -1  # rear ring (us[0]) bulges back (+y), the front one forward (-y)
        inner = [bm.verts.new((cx + (v.co.x - cx) * 0.72, -u_end + out * S.get('cap_bulge', 0.035), cz + (v.co.z - cz) * 0.72)) for v in r]
        mat = S.get('cap_mat', ('paint', 'paint'))[0 if end == 0 else 1]
        for j in range(n):
            k = (j + 1) % n
            q = [r[j], r[k], inner[k], inner[j]] if end == -1 else [r[k], r[j], inner[j], inner[k]]
            f = bm.faces.new(q)
            f.material_index = mi(mat if seg_of[j] else 'dark')
            f.smooth = True
            e = bm.edges.get([r[j], r[k]])
            if e:
                e[crease] = S.get('cap_crease', 0.35)
        f = bm.faces.new(inner if end == -1 else list(reversed(inner)))
        f.material_index = mi(mat)
        f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('body')
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new('body', me)
    coll.objects.link(ob)
    return ob


def apply_modifiers(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)


def cylinder_x(name, c, r, x0, x1, coll, seg=48):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=x1 - x0)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=V((c[0] + (x0 + x1) / 2, c[1], c[2])))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def build_body(S, M, coll):
    ob = body_mesh(S, M, coll)
    sub = ob.modifiers.new('sub', 'SUBSURF')
    sub.levels = sub.render_levels = S.get('subdiv', 2)
    apply_modifiers(ob)
    # wheel arches
    cut_coll = bpy.data.collections.new('CUTTERS')
    bpy.context.scene.collection.children.link(cut_coll)
    r = S['r'] + S.get('arch_gap', 0.035)
    for ua in (S['wb'] / 2, -S['wb'] / 2):
        for s in (1, -1):
            x0, x1 = S['track'] / 2 - S['tyre_w'] / 2 - 0.07, 1.4
            c = cylinder_x('cut', (0, -ua, S['r'] + S.get('arch_lift', 0.012)), r, x0, x1, cut_coll)
            if s < 0:
                c.scale.x = -1
            c.data.materials.append(M['dark'])
    bpy.context.view_layer.update()
    bo = ob.modifiers.new('arches', 'BOOLEAN')
    bo.operation = 'DIFFERENCE'
    bo.operand_type = 'COLLECTION'
    bo.collection = cut_coll
    bo.solver = 'EXACT'
    bo.material_mode = 'TRANSFER'
    apply_modifiers(ob)
    for o in list(cut_coll.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.collections.remove(cut_coll)
    # the Boolean leaves long n-gons round the arches: triangulate them, or they shade in streaks
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4], quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(ob.data)
    bm.free()
    # lower trim (bumper aprons, sills) by face position
    me = ob.data
    names = [m.name for m in me.materials]

    def idx(name):
        if name not in names:
            me.materials.append(M[name])
            names.append(name)
        return names.index(name)

    trim = S.get('trim_faces')
    for p in me.polygons:
        c = p.center
        if p.normal.z < -0.6 and c.z < 0.45:
            p.material_index = idx('dark')
        elif trim:
            name = trim(-c.y, abs(c.x), c.z, me.materials[p.material_index].name)
            if name:
                p.material_index = idx(name)
    return ob


# ---------------------------------------------------------------- decals

def frame_of(d, up=V((0, 0, 1))):
    d = V(d).normalized()
    e1 = up.cross(d)
    if e1.length < 1e-6:
        e1 = V((1, 0, 0))
    e1.normalize()
    e2 = d.cross(e1).normalized()
    return d, e1, e2


def decal(part, body, mat, c, d, outline, off=0.004, bulge=0.0, up=V((0, 0, 1)), max_edge=None):
    """A patch shaped by `outline` (2D points around c in the plane ⟂ d, axes e1 = up×d, e2) ray-cast along d onto
    the body and lifted by off (+ bulge towards the middle). The flat patch is subdivided first (edges ≤ max_edge)
    so it follows curved panels. Returns the 3D centre or None if a ray missed."""
    d, e1, e2 = frame_of(d, up)
    c = V(c)
    xs = [p[0] for p in outline]
    ys = [p[1] for p in outline]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    hw, hh = max(1e-4, (max(xs) - min(xs)) / 2), max(1e-4, (max(ys) - min(ys)) / 2)
    max_edge = max_edge or 0.07
    bm = bmesh.new()
    rings = []
    for s in (1.0, 0.6):
        rings.append([bm.verts.new((cx + (px - cx) * s, cy + (py - cy) * s, 0)) for px, py in outline])
    n = len(outline)
    for ra, rb in zip(rings, rings[1:]):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new([ra[j], ra[k], rb[k], rb[j]])
    bm.faces.new(rings[-1])
    for _ in range(8):
        long = [e for e in bm.edges if e.calc_length() > max_edge]
        if not long:
            break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    vmap = {}
    for v in bm.verts:
        q = v.co
        o = c + e1 * q.x + e2 * q.y - d * 2.5
        ok, loc, nrm, _ = body.ray_cast(o, d, distance=5.0)
        if not ok:
            bm.free()
            print('DECAL_MISS', tuple(round(x, 2) for x in c), mat.name)
            return None
        k = min(1.0, max(abs(q.x - cx) / hw, abs(q.y - cy) / hh))
        vmap[v] = part.bm.verts.new(loc + nrm * (off + bulge * (1 - k * k)))
    centre = None
    for f in bm.faces:
        g = part._face([vmap[v] for v in f.verts], mat)
        g.normal_update()
        if g.normal.dot(d) > 0:  # face the viewer (against the ray)
            g.normal_flip()
    o = c + e1 * cx + e2 * cy - d * 2.5
    ok, loc, nrm, _ = body.ray_cast(o, d, distance=5.0)
    centre = loc + nrm * (off + bulge) if ok else None
    bm.free()
    return centre


def rrect(w, h, r, n=4, cx=0.0, cy=0.0, skew=0.0):
    """Rounded rectangle outline (counter-clockwise), corner radius r; skew shifts the top edge sideways."""
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    pts = []
    for (qx, qy, a0) in ((w / 2 - r, -h / 2 + r, -math.pi / 2), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, math.pi / 2), (-w / 2 + r, -h / 2 + r, math.pi)):
        for i in range(n + 1):
            a = a0 + (math.pi / 2) * i / n
            x, y = qx + r * math.cos(a), qy + r * math.sin(a)
            pts.append((cx + x + skew * (y / (h / 2)), cy + y))
    return pts


def poly_round(pts, r=0.02, n=3):
    """Polygon with its corners rounded (simple fillets)."""
    out = []
    m = len(pts)
    for i in range(m):
        p0, p1, p2 = V(pts[i - 1]), V(pts[i]), V(pts[(i + 1) % m])
        a, b = p0 - p1, p2 - p1
        s = p1 + a.normalized() * min(r, a.length / 2.1)
        e = p1 + b.normalized() * min(r, b.length / 2.1)
        for k in range(n + 1):
            t = k / n
            q = s * (1 - t) ** 2 + p1 * 2 * t * (1 - t) + e * t * t
            out.append((q.x, q.y))
    return out


def decal_object(part, coll, parent):
    """Like Part.to_object but keeps the face winding (decal patches are open; recalc could flip them)."""
    me = bpy.data.meshes.new(part.name)
    part.bm.to_mesh(me)
    part.bm.free()
    for m in part.mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(part.name, me)
    coll.objects.link(ob)
    ob.parent = parent
    return ob


# ---------------------------------------------------------------- wheels

def lathe(part, prof, mat, side, seg=48, closed=True, smooth=True):
    """Surface of revolution about X: prof = [(radius, axial)], axial > 0 = outward (side * +X)."""
    rings = []
    for (rad, ax) in prof:
        rings.append([part.bm.verts.new((side * ax, rad * math.cos(2 * math.pi * i / seg), rad * math.sin(2 * math.pi * i / seg))) for i in range(seg)])
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    for a, b in pairs:
        for i in range(seg):
            k = (i + 1) % seg
            part._face([a[i], a[k], b[k], b[i]], mat, smooth)


def wheel(name, M, S, side, coll, parent, loc):
    """One wheel node (pivot = hub): tyre, rim (alloy spokes or steel with hubcap), brake disc, nuts."""
    R, rr, tw = S['r'], S['rim_r'], S['tyre_w']
    p = Part(name)
    h = tw / 2
    # tyre: rounded sidewalls, three tread grooves
    prof = [(rr + 0.004, -h + 0.012), (R - 0.04, -h), (R - 0.012, -h + 0.008), (R, -h + 0.03)]
    for g in (-0.05, -0.012, 0.03):
        prof += [(R, g - 0.006), (R - 0.009, g - 0.004), (R - 0.009, g + 0.004), (R, g + 0.006)]
    prof += [(R, h - 0.03), (R - 0.012, h - 0.008), (R - 0.04, h), (rr + 0.004, h - 0.012)]
    lathe(p, prof, M['tyre'], side, seg=S.get('tyre_seg', 40))
    style = S.get('wheel', 'alloy')
    face = h - 0.02  # axial position of the rim face
    if style == 'steel':
        lathe(p, [(rr, -h + 0.02), (rr, face - 0.01), (rr - 0.015, face - 0.005), (rr - 0.03, face - 0.03)], M['rim_dark'], side, seg=36, closed=False)
        # plastic hubcap: domed disc with rings
        cap = [(rr - 0.012, face - 0.012), (rr - 0.02, face + 0.002), (rr * 0.75, face + 0.012), (rr * 0.7, face + 0.008),
               (rr * 0.55, face + 0.014), (rr * 0.3, face + 0.024), (0.04, face + 0.03), (0.001, face + 0.032)]
        lathe(p, cap, M['rim'], side, seg=36, closed=False)
        for i in range(10):  # vent slots
            a = 2 * math.pi * (i + 0.5) / 10
            c = V((side * (face + 0.012), math.cos(a) * rr * 0.62, math.sin(a) * rr * 0.62))
            p.box(c, (0.006, 0.025, 0.05), M['dark'], rot=Matrix.Rotation(a, 3, 'X'))
    else:
        # barrel and lip
        lathe(p, [(rr, -h + 0.02), (rr, face - 0.012), (rr + 0.012, face - 0.004), (rr + 0.006, face + 0.004), (rr - 0.012, face)],
              M['rim'], side, seg=40, closed=False)
        lathe(p, [(rr - 0.01, -0.03), (0.02, -0.03)], M['dark'], side, seg=24, closed=False)  # dark well behind the spokes
        lathe(p, [(rr - 0.03, -0.05), (0.06, -0.05)], M['rim_dark'], side, seg=32, closed=False)  # brake disc
        n = S.get('spokes', 5)
        dbl = S.get('double_spokes', False)
        for i in range(n):
            for o in ((-0.09, 0.09) if dbl else (0.0,)):
                a = 2 * math.pi * i / n + o * (0.5 if dbl else 0)
                ca, sa = math.cos(a), math.sin(a)
                r0, r1 = 0.055, rr - 0.008
                w = 0.022 if dbl else 0.04
                pts = []
                for rad, ax, ww in ((r0, face - 0.002, w * 0.9), (r1, face - 0.012, w * 1.3)):
                    for t in (-1, 1):
                        pts.append(V((side * ax, ca * rad - sa * t * ww / 2, sa * rad + ca * t * ww / 2)))
                back = [q - V((side * 0.022, 0, 0)) for q in pts]
                vs = [p.bm.verts.new(q) for q in pts + back]
                for qd in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
                    p._face([vs[j] for j in qd], M['rim'], smooth=False)
        lathe(p, [(0.065, face - 0.01), (0.06, face + 0.002), (0.03, face + 0.006), (0.001, face + 0.007)], M['rim'], side, seg=24, closed=False)
        lathe(p, [(0.026, face + 0.0065), (0.001, face + 0.0075)], M['rim_dark'], side, seg=16, closed=False)  # centre cap
        for i in range(5):
            a = 2 * math.pi * (i + 0.5) / 5
            c = V((side * (face - 0.003), math.cos(a) * 0.045, math.sin(a) * 0.045))
            p.cyl(c, c + V((side * 0.008, 0, 0)), 0.007, M['chrome'], seg=6)
    ob = p.to_object(coll)
    ob.location = loc
    ob.parent = parent
    return ob


# ---------------------------------------------------------------- common details

def exhaust(part, M, body, x, rear_u, r=0.03, length=0.8):
    """Tail pipe tucked under the body at x: the body's underside is sampled with upward rays over the last
    `length` metres, the pipe runs just below the lowest point; the chrome tip sticks out ~5 cm past the rearmost
    point of the body, so it shows from behind."""
    def under(u0, u1, n=6):
        zs = []
        for i in range(n + 1):
            u = u0 + (u1 - u0) * i / n
            ok, loc, _, _ = body.ray_cast(V((x, -u, -1.0)), V((0, 0, 1)), distance=3.0)
            if ok:
                zs.append(loc.z)
        return min(zs) if zs else None

    zf = under(rear_u + 0.35, rear_u + length)  # floor ahead of the apron
    zr = under(rear_u + 0.08, rear_u + 0.35)  # underside of the apron
    if zf is None or zr is None:
        print('EXHAUST_MISS', x, rear_u)
        return
    zf -= r + 0.012
    zr += 0.1 - r - 0.012  # the tip comes out of the apron, not below it
    end = -rear_u + 0.07  # a few cm past the rear face, which bulges ~3.5 cm behind rear_u
    start, bend = -(rear_u + length), -(rear_u + 0.35)
    tip = end - 0.2
    part.tube([V((x, start, zf)), V((x, bend, zf)), V((x, tip, zr))], r * 0.8, M['dark'], seg=10)
    part.cyl(V((x, tip, zr)), V((x, end, zr)), r, M['chrome'], seg=12)
    part.box(V((x * 0.6, start - 0.25, zf + 0.02)), (0.32, 0.45, 0.16), M['dark'])  # silencer


def wipers(part, M, body, S, n=2):
    u = S['screen'][0] - 0.06
    for i in range(n):
        x0 = 0.45 - 0.55 * i
        a = V((x0, -u, 0))
        b = V((x0 - 0.42, -u + 0.05, 0))
        pts = []
        for q in (a, b):
            ok, loc, nrm, _ = body.ray_cast(q + V((0, 0, 3)), V((0, 0, -1)), distance=5)
            pts.append(loc + nrm * 0.012 if ok else q)
        part.cyl(pts[0], pts[1], 0.007, M['trim'], seg=5)


def lamp_pair(part, body, M, mat, u_face, x, z, outline, d_side=0.35, front=True, bulge=0.012):
    """Two mirrored lamps on the front (front=True, rays towards +Y) or rear (towards -Y); returns their centres."""
    out = []
    for s in (1, -1):
        d = V((-s * d_side, 1 if front else -1, 0))
        ol = [(-s * px if front else s * px, py) for px, py in outline]
        if (front and s == 1) or (not front and s == -1):
            ol = list(reversed(ol))
        c = V((s * x, -u_face, z))
        out.append(decal(part, body, M[mat], c, d, ol, bulge=bulge))
    return out


def plate_node(coll, name, target, c, d, parent, off=0.012):
    """An empty where the game draws a number plate: on `target` under the ray from c along d, lifted by off, its
    local −Y along the surface normal (outwards), local Z up, local X to the right of someone reading the plate."""
    d = V(d).normalized()
    ok, loc, nrm, _ = target.ray_cast(V(c) - d * 2.5, d, distance=5.0)
    if not ok:
        print('PLATE_MISS', name)
        return None
    y = -nrm.normalized()
    z = V((0, 0, 1)) - y * y.z
    z.normalize()
    x = y.cross(z)
    ob = empty(coll, name, loc + nrm * off, parent)
    ob.rotation_euler = Matrix((x, y, z)).transposed().to_euler()
    return ob


# ---------------------------------------------------------------- scene / export / review

def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


def empty(coll, name, loc, parent):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.05
    coll.objects.link(ob)
    ob.location = loc
    ob.parent = parent
    return ob


def export_car(path, root):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [root, *root.children_recursive]:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_draco_mesh_compression_enable=False, export_cameras=False, export_lights=False, export_extras=False,
        export_animations=False, export_materials='EXPORT')


def grid(paths, out):
    """2 × 2 contact sheet of the review stills at half size."""
    import numpy as np
    tiles = []
    for p in paths:
        im = bpy.data.images.load(p)
        w, h = im.size
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::2, ::2]
        tiles.append(a)
        bpy.data.images.remove(im)
    top = np.concatenate([tiles[0], tiles[1]], axis=1)
    bot = np.concatenate([tiles[2], tiles[3]], axis=1)
    a = np.concatenate([bot, top], axis=0)  # image rows start at the bottom
    img = bpy.data.images.new('grid', a.shape[1], a.shape[0])
    img.pixels = a.ravel()
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()


def make_lod(root, ratio=0.18):
    """Distance version (same nodes): every mesh decimated in place. Returns its triangle count."""
    tris = 0
    for o in [root, *root.children_recursive]:
        if o.type != 'MESH':
            continue
        m = o.modifiers.new('lod', 'DECIMATE')
        m.ratio = ratio * (2.0 if o.name.startswith('wheel') else 1.0)
        m.use_collapse_triangulate = True
        apply_modifiers(o)
        tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return tris
