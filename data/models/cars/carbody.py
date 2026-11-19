"""Car shell with real window openings, clear glass and doors of their own (run inside Blender, headless is fine).

Builds on the loft of carparts.py (frame and tables as described there and in README.md): the lofted, subdivided skin
is split into the body, one object per door and the glass panes; body and doors get a wall thickness, so every opening
has a reveal and nothing behind a pane is seen from its back. The distance model keeps the closed skin with opaque
glass.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import carparts  # noqa: E402
from carparts import Part, apply_modifiers, frame_of, car_materials, clear_scene, decal, decal_object, export_car, grid, make_lod  # noqa: E402
from nnmodel import material  # noqa: E402

V = Vector

WALL = 0.03  # wall thickness of body and doors (m)
GAP = 0.005  # a door's edge stands this far back from its opening (m)
GLASS_INSET = 0.008  # the panes sit this far inside the outer skin (m)
TAG_BASES = ('paint', 'glass', 'pillar', 'trim')  # materials a door's skin may carry
DOOR_SEGS = (2, 3, 4, 5)  # half-ring segments of a door: lower side … window (the roof rail stays on the body)


# ---------------------------------------------------------------- materials

def car_materials2(paint=(0.55, 0.06, 0.05)):
    """car_materials() with clear glass ('glass', exported as alphaMode BLEND) and the interior set."""
    m = car_materials(paint)
    m['glass_dark'] = material('glass_dark', (0.07, 0.09, 0.1), rough=0.05, metal=0.2)  # the distance model's opaque glass
    m['glass'] = clear('glass', (0.10, 0.13, 0.14), 0.32, rough=0.05)
    m['lens'] = clear('lens', (0.9, 0.9, 0.9), 0.25, rough=0.03)  # clear lamp covers
    m['lens_red'] = clear('lens_red', (0.75, 0.03, 0.02), 0.6, rough=0.05)  # tail lamp covers
    m['pillar'] = material('pillar', (0.015, 0.015, 0.018), rough=0.12)  # gloss black window pillars
    m['interior'] = material('interior', (0.07, 0.07, 0.075), rough=0.8)
    m['interior_trim'] = material('interior_trim', (0.15, 0.15, 0.155), rough=0.6)
    m['seat'] = material('seat', (0.3, 0.3, 0.32), rough=0.9)
    m['rubber'] = material('rubber', (0.02, 0.02, 0.02), rough=0.7)
    # the game has no environment map: fully metallic rims would render black
    m['rim'] = material('rim', (0.72, 0.73, 0.75), rough=0.35, metal=0.5)
    m['rim_dark'] = material('rim_dark', (0.18, 0.18, 0.19), rough=0.5, metal=0.4)
    return m


def clear(name, color, alpha, rough):
    m = material(name, color, rough=rough, metal=0.0)
    m.node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = alpha
    m.surface_render_method = 'BLENDED'
    m.use_backface_culling = True  # glTF: single-sided, so the far panes do not draw over the interior
    m.diffuse_color = (*m.diffuse_color[:3], alpha)
    return m


# ---------------------------------------------------------------- mesh helpers

def subset(me, name, keep):
    """A new mesh of the faces of me for which keep(face, material name) holds (same material slots)."""
    names = [m.name for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    dead = [f for f in bm.faces if not keep(f, names[f.material_index])]
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    out = bpy.data.meshes.new(name)
    bm.to_mesh(out)
    bm.free()
    for m in me.materials:
        out.materials.append(m)
    return out


def slot(me, mat):
    names = [m.name for m in me.materials]
    if mat.name not in names:
        me.materials.append(mat)
        return len(names)
    return names.index(mat.name)


def shrink_boundary(bm, d):
    """Moves the open boundary of bm inwards by d along the surface."""
    acc = {}
    for e in bm.edges:
        if len(e.link_faces) != 1:
            continue
        f = e.link_faces[0]
        a, b = e.verts
        inward = f.normal.cross(b.co - a.co)
        if inward.length < 1e-9:
            continue
        inward.normalize()
        if inward.dot(f.calc_center_median() - (a.co + b.co) / 2) < 0:
            inward = -inward
        for v in (a, b):
            acc[v] = acc.get(v, V((0, 0, 0))) + inward
    for v, n in acc.items():
        if n.length > 1e-9:
            v.co += n.normalized() * d


def boundary_frames(bm):
    """For every vertex on the open boundary of bm: (inward direction along the surface, edges it bounds)."""
    acc = {}
    for e in bm.edges:
        if len(e.link_faces) != 1:
            continue
        f = e.link_faces[0]
        a, b = e.verts
        inward = f.normal.cross(b.co - a.co)
        if inward.length < 1e-9:
            continue
        inward.normalize()
        if inward.dot(f.calc_center_median() - (a.co + b.co) / 2) < 0:
            inward = -inward
        for v in (a, b):
            acc[v] = acc.get(v, V((0, 0, 0))) + inward
    return {v: n.normalized() for v, n in acc.items() if n.length > 1e-9}


def add_seal(seals, me, S, depth=WALL + 0.004, half=0.022):
    """Adds the door seal for the door skin `me` to the bmesh `seals`: a band behind the door's edge all round (just
    behind the wall, reaching `half` to either side of the gap), so nothing shows through the gap of a closed door.
    Left out along the wheel arches, where it would stand in the wheel housing."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    frames = boundary_frames(bm)
    reach = S['r'] + S.get('arch_gap', 0.035) + 0.03
    made = {}

    def pt(v, k):
        if (v, k) not in made:
            made[(v, k)] = seals.verts.new(v.co - v.normal * depth + frames[v] * (k * half))
        return made[(v, k)]

    for e in bm.edges:
        a, b = e.verts
        if len(e.link_faces) != 1 or a not in frames or b not in frames:
            continue
        m = (a.co + b.co) / 2
        if any(math.hypot(m.y + ua, m.z - S['r']) < reach for ua in (S['wb'] / 2, -S['wb'] / 2)):
            continue
        seals.faces.new([pt(a, -1), pt(b, -1), pt(b, 1), pt(a, 1)])
    bm.free()


def piece(me, name, coll, M, gap=0.0, cutters=()):
    """One part of the car from its skin faces: panes set back, the rest given a wall (inside 'interior_trim', edges
    'rubber'), `cutters` subtracted from the wall (their faces line the recesses). Returns the object (at the origin)."""
    for tag in [m.name for m in me.materials if '@' in m.name]:  # door tags back to the real materials
        base = slot(me, M[tag.split('@')[0]])
        t = [m.name for m in me.materials].index(tag)
        for p in me.polygons:
            if p.material_index == t:
                p.material_index = base
    i_trim, i_rubber = slot(me, M['interior_trim']), slot(me, M['rubber'])
    if gap:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.normal_update()
        shrink_boundary(bm, gap)
        bm.to_mesh(me)
        bm.free()
    panes = subset(me, name + '_glass', lambda f, m: m == 'glass')
    wall = subset(me, name, lambda f, m: m != 'glass')
    bpy.data.meshes.remove(me)
    ob = bpy.data.objects.new(name, wall)
    coll.objects.link(ob)
    n = len(wall.polygons)
    so = ob.modifiers.new('wall', 'SOLIDIFY')
    so.thickness = WALL
    so.offset = -1
    so.use_rim = True
    so.use_even_offset = False
    apply_modifiers(ob)
    wall = ob.data
    assert len(wall.polygons) >= 2 * n, 'solidify: unexpected face order'
    bm = bmesh.new()
    bm.from_mesh(wall)
    bm.faces.ensure_lookup_table()
    for f in bm.faces[n:2 * n]:
        f.material_index = i_trim
    for f in bm.faces[2 * n:]:
        f.material_index = i_rubber
        f.smooth = False
        for e in f.edges:
            e.smooth = False
    bm.to_mesh(wall)
    bm.free()
    if cutters:
        cc = bpy.data.collections.new('CUTTERS')
        bpy.context.scene.collection.children.link(cc)
        for c in cutters:
            cc.objects.link(c)
        bpy.context.view_layer.update()
        bo = ob.modifiers.new('cut', 'BOOLEAN')
        bo.operation, bo.operand_type, bo.collection = 'DIFFERENCE', 'COLLECTION', cc
        bo.solver, bo.material_mode = 'EXACT', 'TRANSFER'
        apply_modifiers(ob)
        for c in cutters:
            bpy.data.objects.remove(c, do_unlink=True)
        bpy.data.collections.remove(cc)
        wall = ob.data
    bm = bmesh.new()
    bm.from_mesh(wall)
    # the panes, set back from the skin
    gm = bmesh.new()
    gm.from_mesh(panes)
    gm.normal_update()
    for v in gm.verts:
        v.co -= v.normal * GLASS_INSET
    gm.to_mesh(panes)
    gm.free()
    bm.from_mesh(panes)
    bm.to_mesh(wall)
    bm.free()
    bpy.data.meshes.remove(panes)
    return ob


def set_origin(ob, at):
    """Moves the object's origin to `at` (world) without moving its geometry."""
    at = V(at)
    for v in ob.data.vertices:
        v.co -= at
    ob.location = at


# ---------------------------------------------------------------- shell

class Shell:
    """The finished shell: body, doors, and where things stuck onto the panels go.

    `skin` is the closed, undivided skin, the target for the decal ray casts (removed by finish()). Decals and details
    land in a Part per target (the body or the door their position lies on), so they swing with their door.
    """

    def __init__(self, S, M, coll, body, doors, specs, skin):
        self.S, self.M, self.coll = S, M, coll
        self.body, self.doors, self.specs, self.skin = body, doors, specs, skin
        self.parts = {}

    def target(self, u, x):
        for name, d in self.specs.items():
            if name in self.doors and d['u'][0] <= u <= d['u'][1] and x * d['side'] > 0.3:
                return name
        return 'body'

    def part(self, kind, at=None):
        """The Part for `kind` ('decals' or 'details') on the target under `at` (Blender coordinates; None = body)."""
        t = 'body' if at is None else self.target(-at[1], at[0])
        key = (t, kind)
        if key not in self.parts:
            self.parts[key] = Part(kind if t == 'body' else f'{t}_{kind}')
        return self.parts[key]

    def decal(self, mat, c, d, outline, **kw):
        return decal(self.part('decals', c), self.skin, self.M[mat], c, d, outline, **kw)

    def surface(self, c, d):
        """Where the ray from c − 2.5 d along d meets the skin: (point, normal), or (None, None)."""
        d = V(d).normalized()
        ok, loc, nrm, _ = self.skin.ray_cast(V(c) - d * 2.5, d, distance=5.0)
        return (loc, nrm) if ok else (None, None)

    def finish(self):
        for (t, kind), p in self.parts.items():
            parent = self.body if t == 'body' else self.doors[t]
            ob = decal_object(p, self.coll, parent) if kind == 'decals' else p.to_object(self.coll)
            ob.parent = parent
            ob.location = -parent.location
        bpy.data.objects.remove(self.skin, do_unlink=True)
        self.skin = None


def recess(skin, mat, c, d, outline, depth=0.06, up=V((0, 0, 1))):
    """A cutter for build_shell's `cuts`: the prism of `outline` (as for decal: 2D points round c in the plane ⟂ d)
    from just outside the skin to `depth` behind it, following the skin. Its faces (material mat) line the recess."""
    d, e1, e2 = frame_of(d, up)
    c = V(c)
    bm = bmesh.new()
    front, back = [], []
    for px, py in outline:
        ok, loc, _, _ = skin.ray_cast(c + e1 * px + e2 * py - d * 2.5, d, distance=5.0)
        if not ok:
            bm.free()
            print('RECESS_MISS', tuple(round(x, 2) for x in c), mat.name)
            return None
        front.append(bm.verts.new(loc - d * 0.05))
        back.append(bm.verts.new(loc + d * depth))
    n = len(outline)
    for j in range(n):
        k = (j + 1) % n
        bm.faces.new([front[j], front[k], back[k], back[j]])
    bm.faces.new(front)
    bm.faces.new(back)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('cutter')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    return bpy.data.objects.new('cutter', me)


def pair(front, u_face, x, z, outline, d_side=0.35):
    """Two mirrored placements on the front (rays towards +Y) or rear face: yields (side, centre, direction, outline)."""
    for s in (1, -1):
        d = V((-s * d_side, 1 if front else -1, 0))
        ol = [(-s * px if front else s * px, py) for px, py in outline]
        if (front and s == 1) or (not front and s == -1):
            ol = list(reversed(ol))
        yield s, V((s * x, -u_face, z)), d, ol


def tagged(S, M, specs):
    """S and M for a skin whose door faces carry '<material>@<door group>' materials."""
    groups = sorted({d['u'] for d in specs.values()})
    S = dict(S)
    S['extra'] = list(S.get('extra', [])) + [u for g in groups for u in g]
    M = dict(M)
    for i in range(len(groups)):
        for base in TAG_BASES:
            M[f'{base}@{i}'] = material(f'{base}@{i}', (0.5, 0.5, 0.5))
    plain = carparts.face_material

    def tag(S_, u, seg):
        name = plain(S_, u, seg)
        if seg in DOOR_SEGS and name in TAG_BASES:
            for i, (u0, u1) in enumerate(groups):
                if u0 <= u <= u1:
                    return f'{name}@{i}'
        return name
    return S, M, groups, tag


def build_shell(S, M, coll, doors, cuts=None):
    """doors: {'door_fl': {'u': (rear_u, hinge_u), 'side': +1, 'hinge_x': 0.86}, ...} → Shell (body at the origin,
    doors as its children with their origin on the hinge axis). cuts(skin) may return cutter objects (see recess) that
    are subtracted from the body's wall."""
    S2, M2, groups, tag = tagged(S, M, doors)
    plain = carparts.face_material
    carparts.face_material = tag
    try:
        skin = carparts.build_body(S2, M2, coll)
    finally:
        carparts.face_material = plain
    skin.name = 'skin'
    src = skin.data
    out = {}
    seals = bmesh.new()
    for name, d in doors.items():
        g = groups.index(d['u'])
        me = subset(src, name, lambda f, m, g=g, s=d['side']: m.endswith(f'@{g}') and f.calc_center_median().x * s > 0)
        add_seal(seals, me, S)
        ob = piece(me, name, coll, M, gap=GAP)
        set_origin(ob, (d['hinge_x'], -d['u'][1], 0.0))
        out[name] = ob
    body = piece(subset(src, 'body', lambda f, m: '@' not in m), 'body', coll, M, cutters=cuts(skin) if cuts else ())
    for ob in out.values():
        ob.parent = body
    sme = bpy.data.meshes.new('seals')
    seals.to_mesh(sme)
    seals.free()
    sme.materials.append(M['rubber'])
    so = bpy.data.objects.new('seals', sme)
    coll.objects.link(so)
    so.parent = body
    # the ray target keeps the plain materials
    for i, m in enumerate(src.materials):
        if '@' in m.name:
            src.materials[i] = M[m.name.split('@')[0]]
    skin.hide_render = True
    return Shell(S, M, coll, body, out, doors, skin)


def build_lod_shell(S, M, coll):
    """The distance model's shell: the closed skin with opaque glass; everything lands on the body."""
    body = carparts.build_body(S, {**M, 'glass': M['glass_dark']}, coll)
    skin = body.copy()
    skin.data = body.data.copy()
    skin.name = 'skin'
    coll.objects.link(skin)
    skin.hide_render = True
    return Shell(S, M, coll, body, {}, {}, skin)


# ---------------------------------------------------------------- report / review / run

BASE_NODES = {'body', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'light_fl', 'light_fr', 'tail_l', 'tail_r'}


def report2(root, need):
    bpy.context.view_layer.update()
    lo, hi = V((1e9,) * 3), V((-1e9,) * 3)
    tris = glass = 0
    obs = [root, *root.children_recursive]
    for o in obs:
        if o.type != 'MESH':
            continue
        names = [m.name for m in o.data.materials]
        for p in o.data.polygons:
            t = len(p.vertices) - 2
            tris += t
            if names and names[p.material_index] == 'glass':
                glass += t
        for c in o.bound_box:
            w = o.matrix_world @ V(c)
            lo = V((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = V((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    names = {o.name for o in obs}
    seats = [[round(c, 3) for c in (o.matrix_world.translation.x, -o.matrix_world.translation.y, o.matrix_world.translation.z)]
             for o in sorted((o for o in obs if o.name.startswith('seat_')), key=lambda o: o.name)]
    return {'missing': sorted(set(need) - names), 'length': round(hi.y - lo.y, 3), 'width': round(hi.x - lo.x, 3),
            'height': round(hi.z - lo.z, 3), 'bottom': round(lo.z, 4), 'tris': tris, 'glass_tris': glass, 'seats': seats}


def swing(doors, specs, k):
    """Opens every door by k × its open angle (left doors swing towards +X)."""
    for name, ob in doors.items():
        ob.rotation_euler.z = -specs[name]['side'] * specs[name].get('open', 1.13) * k


def setup_render():
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    try:
        scene.render.engine = 'BLENDER_EEVEE'
        world = bpy.data.worlds.new('review')
        world.use_nodes = True
        world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.62, 0.68, 0.76, 1)
        world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
        scene.world = world
        sun = bpy.data.objects.new('ReviewSun', bpy.data.lights.new('ReviewSun', 'SUN'))
        sun.data.energy = 3.5
        sun.data.angle = 0.15
        sun.rotation_euler = (math.radians(52), 0, math.radians(-38))
        scene.collection.objects.link(sun)
        me = bpy.data.meshes.new('ReviewGround')
        me.from_pydata([(-30, -30, 0), (30, -30, 0), (30, 30, 0), (-30, 30, 0)], [], [(0, 1, 2, 3)])
        me.materials.append(material('review_ground', (0.32, 0.32, 0.33), rough=0.9))
        scene.collection.objects.link(bpy.data.objects.new('ReviewGround', me))
        scene.view_settings.view_transform = 'Standard'
    except TypeError:
        scene.render.engine = 'BLENDER_WORKBENCH'
        sh = scene.display.shading
        sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = 'STUDIO', 'MATERIAL', False, True
    cam = bpy.data.objects.new('ReviewCam', bpy.data.cameras.new('ReviewCam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 50
    return cam


def shoot(cam, path, pos, look, lens=50, ortho=None, clip=0.1):
    """One still. ortho: orthographic scale (m) instead of the lens; clip: near clipping distance (cuts the car open)."""
    cam.data.type = 'ORTHO' if ortho else 'PERSP'
    if ortho:
        cam.data.ortho_scale = ortho
    cam.data.clip_start = clip
    cam.data.lens = lens
    cam.location = pos
    cam.rotation_euler = (V(look) - V(pos)).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def render2(name, out_dir, L, shell, extra=None):
    """Review stills: the four views and their grid as before, plus 'open' (doors open) and 'through' (eye level,
    looking through the glass). extra(shot, shell) may add more; shot(tag, pos, look, lens=50, ortho=, clip=) writes one."""
    cam = setup_render()
    os.makedirs(out_dir, exist_ok=True)
    k = max(L, 3.9) / 4.2

    def shot(tag, pos, look, lens=50, **kw):
        return shoot(cam, os.path.join(out_dir, f'{name}-{tag}.png'), V(pos), look, lens, **kw)

    paths = [shot('34', V((-3.6, -4.6, 1.7)) * k, (0, 0, 0.6)), shot('side', V((-7.0, 0, 0.9)) * k, (0, 0, 0.7)),
             shot('rear', V((3.2, 4.8, 1.8)) * k, (0, 0, 0.6)), shot('front', V((0.0, -6.5, 0.9)) * k, (0, 0, 0.7))]
    grid(paths, os.path.join(out_dir, f'{name}-grid.png'))
    paths.append(shot('through', (3.0, 0.2, 1.6), (0, 0.1, 1.0), lens=32))
    swing(shell.doors, shell.specs, 1)
    paths.append(shot('open', V((4.2, -4.2, 2.3)) * k, (0, 0, 0.6), lens=40))
    swing(shell.doors, shell.specs, 0)
    if extra:
        paths += extra(shot, shell) or []
    return paths


def run2(name, here, build, extra_shots=None):
    """build(coll, lod) → (root, S, shell). Writes <name>.blend, <name>.glb, the review stills and <name>_lod.glb."""
    clear_scene()
    coll = bpy.data.collections.new('CAR_' + name.upper())
    bpy.context.scene.collection.children.link(coll)
    root, S, shell = build(coll, False)
    need = BASE_NODES | set(shell.doors)
    rep = report2(root, need)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(here, f'{name}.blend'))
    export_car(os.path.join(here, f'{name}.glb'), root)
    repo = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
    rep['shots'] = render2(name, os.path.join(repo, 'shots', 'cars'), rep['length'], shell, extra_shots)
    clear_scene()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    coll = bpy.data.collections.new('CAR_' + name.upper() + '_LOD')
    bpy.context.scene.collection.children.link(coll)
    root, S, shell = build(coll, True)
    rep['lod_missing'] = report2(root, BASE_NODES)['missing']
    rep['lod_tris'] = make_lod(root, ratio=0.25)
    export_car(os.path.join(here, f'{name}_lod.glb'), root)
    print('CAR_REPORT', name, rep)
    return rep
