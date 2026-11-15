"""Shared helpers for the procedural bike models in data/models/bikes (run inside Blender).

Frame of every bike (see README.md here): metres, Blender Z up, ground z = 0, origin on the ground midway between
the wheel contact points, the bike faces -Y (glTF export turns that into game +z). Wheels turn about the X axis.

A Part collects geometry in a bmesh in the part's own frame (its origin = the node's pivot, e.g. a wheel hub) and
becomes one object with one material slot per material used. Helpers append primitives: tubes along polylines,
cylinders, boxes, tori (tyres/rims, about X), discs.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from nnmodel import material, reset_collection  # noqa: E402

V = Vector

# ---------------------------------------------------------------- materials

def bike_materials():
    """The shared material set; 'paint' is the frame colour the client recolours per bike."""
    m = {
        'paint': material('paint', (0.18, 0.36, 0.25), rough=0.35, metal=0.3),
        'tyre': material('tyre', (0.06, 0.06, 0.06), rough=0.9),
        'metal': material('metal', (0.78, 0.79, 0.8), rough=0.25, metal=1.0),
        'dark': material('dark', (0.08, 0.08, 0.09), rough=0.55, metal=0.2),
        'saddle': material('saddle', (0.12, 0.09, 0.07), rough=0.6),
        'wood': material('wood', (0.72, 0.55, 0.36), rough=0.7),
        'wood_dark': material('wood_dark', (0.45, 0.32, 0.2), rough=0.75),
        'rubber': material('rubber', (0.1, 0.1, 0.1), rough=0.8),
        'cork': material('cork', (0.55, 0.38, 0.22), rough=0.85),
        'basket': material('basket', (0.2, 0.2, 0.21), rough=0.5, metal=0.6),
        'lamp_front': material('lamp_front', (0.95, 0.95, 0.9), rough=0.1),
        'lamp_rear': material('lamp_rear', (0.75, 0.05, 0.04), rough=0.2),
        'reflector': material('reflector', (0.9, 0.5, 0.05), rough=0.2),
    }
    for name in ('lamp_front', 'lamp_rear'):
        bsdf = m[name].node_tree.nodes['Principled BSDF']
        bsdf.inputs['Emission Color'].default_value = bsdf.inputs['Base Color'].default_value
        bsdf.inputs['Emission Strength'].default_value = 0.0  # the client drives it at night
    return m


# ---------------------------------------------------------------- geometry

def _perp(t):
    """Two unit vectors perpendicular to t (and to each other)."""
    a = V((1, 0, 0)) if abs(t.x) < 0.9 else V((0, 0, 1))
    u = t.cross(a).normalized()
    return u, t.cross(u).normalized()


class Part:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def _mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _face(self, verts, mat, smooth=True):
        f = self.bm.faces.new(verts)
        f.material_index = self._mi(mat)
        f.smooth = smooth
        return f

    def tube(self, pts, r, mat, seg=10, caps=True, radii=None):
        """Round tube along a polyline (radius r, or per point `radii`), mitred at the joints."""
        pts = [V(p) for p in pts]
        n = len(pts)
        rings = []
        u0 = None
        for i, p in enumerate(pts):
            if i == 0:
                t = (pts[1] - p).normalized()
            elif i == n - 1:
                t = (p - pts[i - 1]).normalized()
            else:
                t = ((p - pts[i - 1]).normalized() + (pts[i + 1] - p).normalized()).normalized()
            if u0 is None:
                u, w = _perp(t)
            else:  # parallel transport keeps the ring from twisting
                u = (u0 - t * u0.dot(t)).normalized()
                w = t.cross(u)
            u0 = u
            rr = radii[i] if radii else r
            # mitre: scale the ring in the bend plane so the tube keeps its width
            scale = 1.0
            if 0 < i < n - 1:
                a = (p - pts[i - 1]).normalized()
                scale = 1 / max(0.3, math.sqrt((1 + a.dot((pts[i + 1] - p).normalized())) / 2))
            ring = []
            for k in range(seg):
                ang = 2 * math.pi * k / seg
                d = u * math.cos(ang) + w * math.sin(ang)
                if scale != 1.0:
                    # stretch the component that lies in the bend plane
                    bend = ((pts[i + 1] - p).normalized() - (p - pts[i - 1]).normalized())
                    if bend.length > 1e-6:
                        bend = (bend - t * bend.dot(t)).normalized()
                        d = d + bend * d.dot(bend) * (scale - 1)
                ring.append(self.bm.verts.new(p + d * rr))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for k in range(seg):
                self._face([a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]], mat)
        if caps:
            self._face(list(reversed(rings[0])), mat, smooth=False)
            self._face(rings[-1], mat, smooth=False)

    def cyl(self, a, b, r, mat, seg=12, caps=True):
        self.tube([a, b], r, mat, seg, caps)

    def box(self, c, size, mat, rot=None):
        """Box centred at c with full size (sx, sy, sz); rot: optional 3×3 Matrix."""
        c = V(c)
        sx, sy, sz = (s / 2 for s in size)
        R = rot or Matrix.Identity(3)
        vs = [self.bm.verts.new(c + R @ V((x * sx, y * sy, z * sz))) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self._face([vs[i] for i in q], mat, smooth=False)

    def torus_x(self, c, R, r, mat, seg=32, rseg=8, squash=1.0):
        """Torus around the X axis through c (a tyre or rim); squash < 1 flattens the tube sideways."""
        c = V(c)
        rings = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            radial = V((0, math.cos(a), math.sin(a)))
            ring = []
            for k in range(rseg):
                b = 2 * math.pi * k / rseg
                p = c + radial * (R + r * math.cos(b)) + V((r * squash * math.sin(b), 0, 0))
                ring.append(self.bm.verts.new(p))
            rings.append(ring)
        for i in range(seg):
            a, b = rings[i], rings[(i + 1) % seg]
            for k in range(rseg):
                self._face([a[k], b[k], b[(k + 1) % rseg], a[(k + 1) % rseg]], mat)

    def disc_x(self, c, r, thick, mat, seg=24):
        """Flat disc about the X axis (chainring, hub flange)."""
        c = V(c)
        self.cyl(c - V((thick / 2, 0, 0)), c + V((thick / 2, 0, 0)), r, mat, seg)

    def to_object(self, coll, parent=None, location=(0, 0, 0)):
        me = bpy.data.meshes.new(self.name)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(self.name, me)
        coll.objects.link(ob)
        _place(ob, location, parent)
        return ob


def _place(ob, location, parent):
    """Puts ob at world `location`, parented without changing that (parents are only translated)."""
    ob.location = location
    if parent is not None:
        bpy.context.view_layer.update()  # parent.matrix_world is stale until the depsgraph updates
        ob.parent = parent
        ob.matrix_parent_inverse = parent.matrix_world.inverted()


def clear_default_scene():
    """Removes the factory-startup cube, light and camera (headless builds)."""
    for name in ('Cube', 'Light', 'Camera'):
        ob = bpy.data.objects.get(name)
        if ob is not None:
            bpy.data.objects.remove(ob, do_unlink=True)


def empty(coll, name, loc, parent=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.05
    coll.objects.link(ob)
    _place(ob, loc, parent)
    return ob


# ---------------------------------------------------------------- bike parts (built at the part's own origin)

def wheel(part, M, radius, tyre_w=0.045, spokes=32, knobby=False, rim='metal'):
    """Tyre, rim, hub and crossed spokes around the origin (hub), turning about X."""
    tr = tyre_w / 2
    part.torus_x((0, 0, 0), radius - tr, tr, M['tyre'], seg=48, rseg=10, squash=1.0)
    if knobby:  # lugs on the tread
        for i in range(40):
            a = 2 * math.pi * i / 40
            d = V((0, math.cos(a), math.sin(a)))
            for s in (-1, 1):
                part.box(d * (radius - 0.004) + V((s * tr * 0.55, 0, 0)), (tyre_w * 0.32, 0.018, 0.012), M['tyre'],
                         rot=Matrix.Rotation(a + math.pi / 2, 3, 'X'))
    rim_r = radius - tyre_w * 0.95
    part.torus_x((0, 0, 0), rim_r, 0.011, M[rim], seg=48, rseg=6, squash=1.4)
    part.cyl((-0.05, 0, 0), (0.05, 0, 0), 0.016, M['metal'], seg=10)
    for s in (-1, 1):
        part.disc_x((s * 0.035, 0, 0), 0.028, 0.004, M['metal'], seg=12)
    for i in range(spokes):
        a = 2 * math.pi * i / spokes
        side = 1 if i % 2 else -1
        lead = 0.35 * side  # tangential lacing
        hub = V((side * 0.035, math.cos(a + lead) * 0.026, math.sin(a + lead) * 0.026))
        rimp = V((side * 0.006, math.cos(a) * (rim_r - 0.008), math.sin(a) * (rim_r - 0.008)))
        part.cyl(hub, rimp, 0.0012, M['metal'], seg=4, caps=False)


def saddle(part, M, at, kind='comfort'):
    """Saddle on top of a seat post ending at `at`; kind 'comfort' (wide, sprung), 'sport' (narrow), 'race'."""
    at = V(at)
    w = {'comfort': 0.24, 'sport': 0.15, 'race': 0.13}[kind]
    length = {'comfort': 0.27, 'sport': 0.27, 'race': 0.28}[kind]
    # a tapered pad: rings from the nose (-Y) to the back (+Y), flattened to a pad
    pts, radii = [], []
    for i in range(7):
        t = i / 6
        pts.append(at + V((0, -length / 2 + length * t, 0.045 + 0.01 * math.sin(math.pi * t))))
        radii.append(0.022 + (w / 2 - 0.022) * t ** 1.6)
    first = len(part.bm.verts)
    part.tube(pts, 0, M['saddle'], seg=14, radii=radii)
    part.bm.verts.ensure_lookup_table()
    for v in part.bm.verts[first:]:
        v.co.z = at.z + 0.045 + (v.co.z - at.z - 0.045) * 0.35
    if kind == 'comfort':
        for s in (-1, 1):
            part.tube([at + V((s * 0.05, 0.07, 0.015)), at + V((s * 0.055, 0.075, -0.03)), at + V((s * 0.04, 0.06, -0.045))], 0.008, M['metal'], seg=6)
    part.cyl(at + V((0, 0, 0.02)), at + V((0, 0, -0.02)), 0.014, M['dark'], seg=8)


def handlebar(part, M, at, kind='swept', width=0.6):
    """Handlebar clamped at `at` (stem top). Returns (grip_l, grip_r) points (rider's left = +X)."""
    at = V(at)
    hw = width / 2
    if kind == 'swept':  # Dutch: sweeps back towards the rider (+Y)
        for s in (-1, 1):
            pts = [at + V((s * x * hw, y, z)) for x, y, z in ((0, 0, 0), (0.35, 0.02, 0.01), (0.75, 0.12, 0.02), (1.0, 0.26, 0.0))]
            part.tube(pts, 0.011, M['metal'], seg=8, caps=False)
            part.cyl(at + V((s * hw * 0.94, 0.15, 0.015)), at + V((s * hw * 1.01, 0.28, -0.002)), 0.017, M['cork'], seg=10)
        grips = (at + V((hw * 0.98, 0.22, 0.008)), at + V((-hw * 0.98, 0.22, 0.008)))
    elif kind == 'drop':  # road: drops below and forward
        for s in (-1, 1):
            pts = [at, at + V((s * 0.19, 0, 0)), at + V((s * 0.21, -0.07, -0.01)), at + V((s * 0.21, -0.09, -0.06)),
                   at + V((s * 0.21, -0.06, -0.12)), at + V((s * 0.21, 0.04, -0.14))]
            part.tube(pts, 0.012, M['dark'], seg=8, caps=False)
            part.box(at + V((s * 0.21, -0.07, 0.025)), (0.025, 0.05, 0.05), M['dark'])  # brake hoods
        grips = (at + V((0.21, -0.07, 0.03)), at + V((-0.21, -0.07, 0.03)))
    else:  # riser: flat and wide (MTB, Long John)
        pts = [at + V((-hw, 0.02, 0.03)), at + V((-0.08, 0, 0.0)), at + V((0.08, 0, 0.0)), at + V((hw, 0.02, 0.03))]
        part.tube(pts, 0.012, M['dark'], seg=8)
        for s in (-1, 1):
            g = at + V((s * (hw - 0.06), 0.02, 0.03))
            part.cyl(g - V((s * 0.06, 0, 0)), g + V((s * 0.06, 0, 0)), 0.017, M['rubber'], seg=10)
        grips = (at + V((hw - 0.07, 0.02, 0.03)), at + V((-(hw - 0.07), 0.02, 0.03)))
    part.cyl(at + V((0, 0, -0.01)), at + V((0, 0.04, 0.0)), 0.02, M['dark'], seg=10)  # stem clamp
    return grips


def crankset(part, M, ring_r=0.1, arm=0.17):
    """Chainring (right side, -X) and two crank arms about the bottom bracket at the origin. Arm 'up' at crank 0."""
    part.disc_x((-0.05, 0, 0), ring_r, 0.006, M['dark'], seg=32)
    part.cyl((-0.07, 0, 0), (0.07, 0, 0), 0.018, M['metal'], seg=10)
    part.box((-0.075, 0, arm / 2), (0.014, 0.03, arm + 0.03), M['metal'])
    part.box((0.075, 0, -arm / 2), (0.014, 0.03, arm + 0.03), M['metal'])
    return (V((0.1, 0, -arm)), V((-0.1, 0, arm)))  # pedal_l (+X side, arm down), pedal_r (-X side, arm up)


def pedal(part, M):
    part.box((0, 0, 0), (0.09, 0.07, 0.022), M['dark'])
    part.cyl((-0.03, 0, 0), (0.03, 0, 0), 0.006, M['metal'], seg=6)


def lamp(part, M, kind):
    if kind == 'front':
        part.cyl((0, 0.03, 0), (0, -0.03, 0), 0.035, M['dark'], seg=14)
        part.disc_x((0, 0, 0), 0.001, 0.001, M['dark'], seg=4)
        part.cyl((0, -0.03, 0), (0, -0.036, 0), 0.03, M['lamp_front'], seg=14)
    else:
        part.box((0, 0, 0), (0.05, 0.02, 0.035), M['dark'])
        part.box((0, 0.012, 0), (0.044, 0.006, 0.03), M['lamp_rear'])


def fender(part, M, radius, a0, a1, width=0.05, mat='dark', c=(0, 0, 0)):
    """Mudguard arc around the hub at c (part frame) from angle a0 to a1 (0 = -Y front, pi/2 = up)."""
    c = V(c)
    pts = []
    for i in range(13):
        a = a0 + (a1 - a0) * i / 12
        pts.append(c + V((0, -math.cos(a) * radius, math.sin(a) * radius)))
    part.tube(pts, width / 2, M[mat], seg=6, caps=True, radii=[width / 2] * len(pts))


# ---------------------------------------------------------------- export

def export_bike(path, root):
    """glTF binary of root and all its children (hierarchy, names and empties kept), +Y up."""
    bpy.ops.object.select_all(action='DESELECT')
    objs = [root, *root.children_recursive]
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_draco_mesh_compression_enable=False, export_cameras=False, export_lights=False, export_extras=False,
        export_animations=False, export_materials='EXPORT')


def check_bike(root, length_range, wheels=('wheel_front', 'wheel_rear')):
    """The node contract of README.md: required nodes, length, ground contact, facing -Y. Returns a report dict."""
    names = {o.name for o in [root, *root.children_recursive]}
    need = {'frame', 'fork', *wheels, 'crank', 'pedal_l', 'pedal_r', 'light_front', 'light_rear', 'seat', 'grip_l', 'grip_r'}
    missing = sorted(need - names)
    bpy.context.view_layer.update()
    lo = V((1e9, 1e9, 1e9))
    hi = -lo
    for o in [root, *root.children_recursive]:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ V(c)
            lo = V((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = V((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    ob = bpy.data.objects
    front_y = min(ob[w].matrix_world.translation.y for w in wheels if w.startswith('wheel_front'))
    rear_y = ob['wheel_rear'].matrix_world.translation.y
    rep = {
        'missing': missing, 'length': round(hi.y - lo.y, 3), 'width': round(hi.x - lo.x, 3), 'height': round(hi.z - lo.z, 3),
        'bottom': round(lo.z, 4), 'faces_minus_y': front_y < rear_y,
    }
    ok = not missing and length_range[0] <= rep['length'] <= length_range[1] and abs(lo.z) <= 0.01 and rep['faces_minus_y']
    rep['ok'] = ok
    return rep


__all__ = ['Part', 'V', 'Matrix', 'bike_materials', 'check_bike', 'clear_default_scene', 'crankset', 'empty', 'export_bike', 'fender',
           'handlebar', 'lamp', 'pedal', 'reset_collection', 'saddle', 'wheel']
