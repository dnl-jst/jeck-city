"""Traffic lights: signal_car (car signal on a 3.5 m pole), signal_ped (pedestrian signal on a 2.6 m pole) and
signal_carped (car signal with two pedestrian heads lower down, facing both ways across the crossing).

Run headless:  blender -b --factory-startup --python data/models/signals/build.py
Frame: origin on the ground at the pole's foot; the car lights face -Y (= game +z at heading 0, like the bikes).
Nodes (the client switches them by name): pole (root, static parts), lamp_red, lamp_amber, lamp_green (car head),
lamp_ped_red, lamp_ped_green (pedestrian head: the standing / walking man itself is the lit mesh). The lamp materials
have the same names and an emission colour at strength 0 (the client lights them).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'bikes'))
sys.path.insert(0, os.path.join(HERE, '..'))
from bikeparts import Part, V, clear_default_scene, export_bike, render, reset_collection  # noqa: E402
from nnmodel import material  # noqa: E402

import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402

POLE_R = 0.055


def materials():
    m = {
        'pole': material('pole', (0.55, 0.57, 0.56), rough=0.5, metal=0.5),          # RAL 7042-like grey
        'housing': material('housing', (0.04, 0.04, 0.045), rough=0.6),
        'plate_white': material('plate_white', (0.92, 0.92, 0.9), rough=0.6),
        'lens': material('lens', (0.03, 0.03, 0.035), rough=0.15),
        'lamp_red': material('lamp_red', (0.85, 0.06, 0.03), rough=0.2),
        'lamp_amber': material('lamp_amber', (0.95, 0.55, 0.02), rough=0.2),
        'lamp_green': material('lamp_green', (0.1, 0.85, 0.45), rough=0.2),
        'lamp_ped_red': material('lamp_ped_red', (0.85, 0.06, 0.03), rough=0.2),
        'lamp_ped_green': material('lamp_ped_green', (0.1, 0.85, 0.45), rough=0.2),
    }
    for k in ('lamp_red', 'lamp_amber', 'lamp_green', 'lamp_ped_red', 'lamp_ped_green'):
        bsdf = m[k].node_tree.nodes['Principled BSDF']
        bsdf.inputs['Emission Color'].default_value = bsdf.inputs['Base Color'].default_value
        bsdf.inputs['Emission Strength'].default_value = 0.0
    return m


def rot_z(a):
    return Matrix.Rotation(a, 3, 'Z')


def car_head(p, M, z0, lamps, coll, parent):
    """Black housing with three lights (top red) over z0..z0+0.86 in front of the pole (−Y), visors, and the black
    contour plate with a white rim behind. Adds the three lamp discs as their own objects."""
    zc = z0 + 0.43
    p.box(V((0, -0.17, zc)), (0.3, 0.24, 0.86), M['housing'])
    p.box(V((0, -0.035, zc)), (0.5, 0.02, 1.1), M['housing'])          # contour plate
    p.box(V((0, -0.02, zc)), (0.54, 0.012, 1.14), M['plate_white'])    # its white rim (visible round the edge)
    p.cyl(V((0, -0.05, zc)), V((0, 0, zc)), 0.05, M['pole'], seg=10)   # bracket to the pole
    for i, (name, z) in enumerate((('lamp_red', zc + 0.28), ('lamp_amber', zc), ('lamp_green', zc - 0.28))):
        # visor: a hood over each light
        pts = [V((0.11 * math.cos(a), -0.29 - 0.0 * i, z + 0.11 * math.sin(a))) for a in (0, 0.5, 1.0, 1.57, 2.1, 2.6, 3.14)]
        hood = [V((q.x, q.y - 0.09, q.z)) for q in pts]
        for a, b, c, d in zip(pts, pts[1:], hood[1:], hood):
            p._face([p.bm.verts.new(a), p.bm.verts.new(b), p.bm.verts.new(c), p.bm.verts.new(d)], M['housing'], smooth=False)
        lamp = Part(name)
        lamp.cyl(V((0, -0.285, z)), V((0, -0.3, z)), 0.1, M[name], seg=20)
        lamps.append(lamp.to_object(coll, parent))


def man(part, M, name, cx, cz, y, walking, s=1.0):
    """Pedestrian pictogram (standing or walking) in the XZ plane at y, facing −Y, about 0.2 m tall."""
    mat = M[name]
    d = 0.012
    yc = y - d / 2

    def limb(a, b, r=0.011):
        part.cyl(V((cx + a[0] * s, yc, cz + a[1] * s)), V((cx + b[0] * s, yc, cz + b[1] * s)), r * s, mat, seg=8)

    part.cyl(V((cx, y, cz + 0.085 * s)), V((cx, y - d, cz + 0.085 * s)), 0.021 * s, mat, seg=12)     # head
    if walking:
        # body leaning into the step, legs in stride from the hip, arms swinging from the shoulder
        limb((0.0, 0.05), (-0.004, -0.02), 0.022)
        limb((-0.004, -0.02), (0.045, -0.105))
        limb((-0.004, -0.02), (-0.04, -0.1))
        limb((0.0, 0.045), (0.04, -0.005), 0.009)
        limb((0.0, 0.045), (-0.035, 0.0), 0.009)
    else:
        part.box(V((cx, yc, cz + 0.02 * s)), (0.05 * s, d, 0.09 * s), mat)                            # body
        for sgn in (1, -1):
            limb((sgn * 0.013, -0.02), (sgn * 0.014, -0.11))                                          # legs
            limb((sgn * 0.033, 0.058), (sgn * 0.036, -0.012), 0.009)                                  # arms


def ped_head(p, M, z0, coll, parent, rot=None, out=0.0):
    """Two-light pedestrian head (red man above, green man below) over z0..z0+0.56, `out` m in front of the pole
    (−Y, turned by `rot` about Z). Adds lamp_ped_red / lamp_ped_green (the men themselves) as objects."""
    R = rot or Matrix.Identity(3)
    zc = z0 + 0.28
    q = lambda x, y, z: R @ V((x, y, z))  # noqa: E731
    p.box(q(0, -0.13 - out, zc), (0.26, 0.2, 0.56), M['housing'], rot=R)
    p.cyl(q(0, -0.03 - out, zc), q(0, 0, zc), 0.04, M['pole'], seg=10)
    for z in (zc + 0.135, zc - 0.135):
        p.cyl(q(0, -0.235 - out, z), q(0, -0.245 - out, z), 0.1, M['lens'], seg=20)
    for name, z, walking in (('lamp_ped_red', zc + 0.135, False), ('lamp_ped_green', zc - 0.135, True)):
        lamp = Part(name)
        man(lamp, M, name, 0, z, -0.25 - out, walking)
        if rot is not None:
            for v in lamp.bm.verts:
                v.co = R @ v.co
        lamps = lamp.to_object(coll, parent)
        lamps.name = name


def pole(name, M, coll, height):
    p = Part(name)
    p.cyl(V((0, 0, -0.05)), V((0, 0, height)), POLE_R, M['pole'], seg=14)
    p.cyl(V((0, 0, height)), V((0, 0, height + 0.03)), POLE_R + 0.01, M['pole'], seg=14)
    p.cyl(V((0, 0, 0)), V((0, 0, 0.25)), POLE_R + 0.02, M['pole'], seg=14)  # foot
    return p


def build_one(kind, M, coll):
    if kind == 'signal_car':
        p = pole('pole', M, coll, 3.5)
        root = bpy.data.objects.new('signal_car', None)
        coll.objects.link(root)
        lamps = []
        car_head(p, M, 2.45, lamps, coll, root)
        ob = p.to_object(coll, root)
    elif kind == 'signal_ped':
        p = pole('pole', M, coll, 2.6)
        root = bpy.data.objects.new('signal_ped', None)
        coll.objects.link(root)
        ped_head(p, M, 1.95, coll, root)
        ob = p.to_object(coll, root)
    else:
        p = pole('pole', M, coll, 3.5)
        root = bpy.data.objects.new('signal_carped', None)
        coll.objects.link(root)
        lamps = []
        car_head(p, M, 2.45, lamps, coll, root)
        # two pedestrian heads facing across the crossing, both ways (±X)
        side = Part('ped_heads')
        ped_head(side, M, 1.6, coll, root, rot=rot_z(math.pi / 2), out=0.0)
        ob = p.to_object(coll, root)
        side_ob = side.to_object(coll, root)
        side_ob.name = 'ped_heads'
        # the second head: a copy of the pictograms turned the other way
        for name in ('lamp_ped_red', 'lamp_ped_green'):
            src = bpy.data.objects[name]
            src.name = name
        p2 = Part('ped_heads_b')
        ped_head(p2, M, 1.6, coll, root, rot=rot_z(-math.pi / 2), out=0.0)
        p2.to_object(coll, root).name = 'ped_heads_b'
        # join each pair of men into one lamp object per colour
        for name in ('lamp_ped_red', 'lamp_ped_green'):
            obs = [o for o in coll.objects if o.name.startswith(name)]
            bpy.ops.object.select_all(action='DESELECT')
            for o in obs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = obs[0]
            bpy.ops.object.join()
            obs[0].name = name
            obs[0].data.name = name
    ob.name = 'pole'
    return root


def build():
    clear_default_scene()
    M = materials()
    repo = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
    shots = []
    for kind in ('signal_car', 'signal_ped', 'signal_carped'):
        coll = reset_collection(kind.upper())
        for c in bpy.data.collections:
            if c.name != coll.name and c.name.startswith('SIGNAL'):
                bpy.context.scene.collection.children.unlink(c) if c.name in bpy.context.scene.collection.children else None
        root = build_one(kind, M, coll)
        names = sorted(o.name for o in root.children_recursive)
        print(kind, names)
        export_bike(os.path.join(HERE, f'{kind}.glb'), root)
        # light up the lamps for the review stills only
        for k in ('lamp_red', 'lamp_green', 'lamp_ped_green'):
            M[k].node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 3.0
        view = {'34': (V((-2.4, -3.6, 2.6)), V((0, 0, 2.2 if kind != 'signal_ped' else 1.8))),
                'front': (V((0, -3.0, 2.4)), V((0, 0, 2.4 if kind != 'signal_ped' else 2.1)))}
        shots += render(kind, os.path.join(repo, 'shots', 'signals'), view)
        for k in ('lamp_red', 'lamp_green', 'lamp_ped_green'):
            M[k].node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 0.0
        # off with this kind entirely, so the next one gets the same object names (no .001)
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for me in [m for m in bpy.data.meshes if m.users == 0]:
            bpy.data.meshes.remove(me)
        bpy.data.collections.remove(coll)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'signals.blend'))
    return {'ok': True, 'shots': shots}


result = build()
print(result)
