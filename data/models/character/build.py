"""Player characters (a man and a woman) generated with MPFB2 (MakeHuman for Blender) and exported as skinned glTF.

Needs Blender with the MPFB extension (extensions.blender.org, "MPFB") and these MakeHuman system assets (CC0) in
MPFB's user data dir (~/.config/blender/<ver>/extensions/.user/blender_org/mpfb/data): skins young_caucasian_male /
young_caucasian_female, eyes (high-poly + materials), eyebrows eyebrow001 / eyebrow012, eyelashes eyelashes01 /
eyelashes02, hair short02 / ponytail01, clothes male_casualsuit05, female_casualsuit01, shoes05, shoes06. See README.md.

Run inside Blender (MCP or the text editor):  exec(open(PATH).read(), {'__file__': PATH})
(MPFB is not loaded with --factory-startup, so a plain headless run needs the user's Blender config.)

Writes character_<variant>.blend / .glb and review stills shots/character/<variant>-*.png.

Frame (as the bikes): metres, Blender Z up, feet on z = 0, facing -Y (= game +z), the figure's left = +X.
The rest pose is the game's neutral pose: standing straight, arms hanging at the sides, legs straight down. The client
reads the joint positions from the bones (apps/client/src/player.ts), so proportions may differ per variant.
"""
import importlib
import os
import re
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
V = Vector

VARIANTS = {
    'man': {
        'macro': {'gender': 1.0, 'age': 0.5, 'muscle': 0.55, 'weight': 0.5, 'proportions': 0.5, 'height': 0.54,
                  'cupsize': 0.5, 'firmness': 0.5, 'race': {'asian': 0.0, 'caucasian': 1.0, 'african': 0.0}},
        'skin': 'young_caucasian_male',
        'eyes': 'brownlight',
        'assets': [('eyebrows', 'eyebrow001', 'Eyebrows'), ('eyelashes', 'eyelashes01', 'Eyelashes'),
                   ('hair', 'short02', 'Hair'), ('clothes', 'male_casualsuit05', 'Clothes'), ('clothes', 'shoes06', 'Clothes')],
    },
    'woman': {
        'macro': {'gender': 0.0, 'age': 0.5, 'muscle': 0.5, 'weight': 0.5, 'proportions': 0.5, 'height': 0.56,
                  'cupsize': 0.5, 'firmness': 0.5, 'race': {'asian': 0.0, 'caucasian': 1.0, 'african': 0.0}},
        'skin': 'young_caucasian_female',
        'eyes': 'bluegreen',
        'assets': [('eyebrows', 'eyebrow012', 'Eyebrows'), ('eyelashes', 'eyelashes02', 'Eyelashes'),
                   ('hair', 'ponytail01', 'Hair'), ('clothes', 'female_casualsuit01', 'Clothes'), ('clothes', 'shoes05', 'Clothes')],
    },
}

# Neutral pose: the direction each limb bone points in (armature space), applied as the new rest pose.
# Arms hang with a slight outward angle so the hands clear the hips; legs straight down at hip width.
ARM_DOWN = {'l': V((0.10, 0.0, -1.0)).normalized(), 'r': V((-0.10, 0.0, -1.0)).normalized()}
FOREARM_DOWN = {'l': V((0.06, -0.08, -1.0)).normalized(), 'r': V((-0.06, -0.08, -1.0)).normalized()}
LEG_DOWN = V((0.0, 0.0, -1.0))


def mpfb(module, key):
    """MPFB lives somewhere under bl_ext.*; find the loaded module by suffix."""
    for name in list(sys.modules):
        if name.endswith(module):
            return getattr(importlib.import_module(name), key)
    raise RuntimeError(f'MPFB module {module} not loaded: install/enable the MPFB extension')


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def eye_material(name, assets_eyes_dir):
    """MPFB's eye mhclo points at a material file the CC0 pack lacks: a plain textured Principled material."""
    m = bpy.data.materials.new(f'eyes_{name}')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(os.path.join(assets_eyes_dir, 'materials', f'{name}_eye.png'), check_existing=True)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    # the cornea shell is transparent in the texture: clip it (Round(alpha) = glTF alphaMode MASK)
    r = nt.nodes.new('ShaderNodeMath')
    r.operation = 'ROUND'
    nt.links.new(tex.outputs['Alpha'], r.inputs[0])
    nt.links.new(r.outputs['Value'], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.15
    return m


def create(variant):
    HS = mpfb('mpfb.services.humanservice', 'HumanService')
    AS = mpfb('mpfb.services.assetservice', 'AssetService')
    spec = VARIANTS[variant]
    bm = HS.create_human(macro_detail_dict=spec['macro'])
    bm.name = variant
    HS.set_character_skin(AS.find_asset_absolute_path(f"{spec['skin']}.mhmat", asset_subdir='skins'), bm, skin_type='GAMEENGINE')
    rig = HS.add_builtin_rig(bm, 'game_engine')
    eyes = AS.find_asset_absolute_path('high-poly.mhclo', asset_subdir='eyes')
    HS.add_mhclo_asset(eyes, bm, asset_type='Eyes', material_type='GAMEENGINE')
    for sub, name, kind in spec['assets']:
        path = AS.find_asset_absolute_path(f'{name}.mhclo', asset_subdir=sub)
        if path is None:
            raise RuntimeError(f'MakeHuman asset {sub}/{name} not installed (see the docstring)')
        HS.add_mhclo_asset(path, bm, asset_type=kind, material_type='GAMEENGINE')
    eye_ob = next(o for o in rig.children if o.name.endswith('high-poly'))
    eye_ob.data.materials.clear()
    eye_ob.data.materials.append(eye_material(spec['eyes'], os.path.dirname(os.path.dirname(eyes))))
    return bm, rig


def bake(rig):
    """Shape keys (the body shape) into the mesh; masks applied, so helper geometry and the body under the clothes are
    gone; subdivision applied on the clothes. Only the armature modifier remains."""
    view = bpy.context.view_layer
    for ob in rig.children:
        if ob.type != 'MESH':
            continue
        view.objects.active = ob
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            if ob.data.shape_keys:
                bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
            for mod in list(ob.modifiers):
                if mod.type not in ('MASK', 'SUBSURF'):
                    continue
                if mod.type == 'SUBSURF':
                    mod.levels = mod.render_levels
                if mod.type == 'SUBSURF' and mod.levels == 0:
                    ob.modifiers.remove(mod)
                    continue
                mod.show_viewport = True
                bpy.ops.object.modifier_apply(modifier=mod.name)
    # vertex groups the game does not need (helpers, MPFB bookkeeping): keep only the bone groups
    bones = {b.name for b in rig.data.bones}
    for ob in rig.children:
        for g in list(ob.vertex_groups):
            if g.name not in bones:
                ob.vertex_groups.remove(g)


# Asset types whose texture alpha cuts strands (alpha clip); everything else is opaque. MPFB's game-engine materials
# all link the texture alpha, which glTF exports as alphaMode BLEND: three.js then sorts the parts per object and hair,
# shirt or legs vanish or show their inside depending on the view.
CLIPPED = ('eyebrow', 'eyelashes', 'short02', 'ponytail01')
HAIR_CUTOFF = 0.35


def fix_materials(rig):
    for ob in rig.children:
        if ob.type != 'MESH':
            continue
        clipped = any(k in ob.name for k in CLIPPED)
        for slot in ob.material_slots:
            m = slot.material
            if not m or not m.node_tree or m.name.startswith('eyes_'):
                continue
            nt = m.node_tree
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            alpha = bsdf.inputs['Alpha']
            src = alpha.links[0].from_socket if alpha.links else None
            for link in list(alpha.links):
                nt.links.remove(link)
            alpha.default_value = 1.0
            if clipped and src is not None:
                # glTF exporter: Alpha <- (texture alpha > cutoff) is written as alphaMode MASK with that cutoff
                gt = nt.nodes.new('ShaderNodeMath')
                gt.operation = 'GREATER_THAN'
                gt.inputs[1].default_value = HAIR_CUTOFF
                nt.links.new(src, gt.inputs[0])
                nt.links.new(gt.outputs['Value'], alpha)
                m.use_backface_culling = False
            else:
                m.use_backface_culling = True
            m.surface_render_method = 'DITHERED'


def aim(rig, name, direction):
    """Rotates pose bone `name` (in armature space, about its head) so it points along `direction`."""
    bpy.context.view_layer.update()
    pb = rig.pose.bones[name]
    m = pb.matrix.copy()
    head = m.translation.copy()
    cur = (pb.tail - pb.head).normalized()
    rot = cur.rotation_difference(direction.normalized()).to_matrix().to_4x4()
    m.translation = V((0, 0, 0))
    m = rot @ m
    m.translation = head
    pb.matrix = m
    bpy.context.view_layer.update()


def neutral_rest(rig):
    """Poses arms down and legs straight, then makes that the rest pose (meshes re-bound)."""
    feet = {s: (rig.data.bones[f'foot_{s}'].tail_local - rig.data.bones[f'foot_{s}'].head_local) for s in ('l', 'r')}
    for s in ('l', 'r'):
        aim(rig, f'upperarm_{s}', ARM_DOWN[s])
        aim(rig, f'lowerarm_{s}', FOREARM_DOWN[s])
        aim(rig, f'thigh_{s}', LEG_DOWN)
        aim(rig, f'calf_{s}', LEG_DOWN)
        d = feet[s]
        aim(rig, f'foot_{s}', V((0, d.y, d.z)).normalized())  # forward and down as before, no toe-out
    view = bpy.context.view_layer
    for ob in rig.children:
        if ob.type != 'MESH':
            continue
        arm_mod = next(m for m in ob.modifiers if m.type == 'ARMATURE')
        view.objects.active = ob
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            bpy.ops.object.modifier_apply(modifier=arm_mod.name)
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig
    view.objects.active = rig
    with bpy.context.temp_override(object=rig, active_object=rig, selected_objects=[rig]):
        bpy.ops.object.mode_set(mode='POSE')
        bpy.ops.pose.select_all(action='SELECT')
        bpy.ops.pose.armature_apply(selected=False)
        bpy.ops.object.mode_set(mode='OBJECT')


def ground(rig):
    """Lowest vertex (the soles) to z = 0, transforms applied."""
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    lo = min((o.matrix_world @ v.co).z for o in rig.children if o.type == 'MESH'
             for v in o.evaluated_get(deps).data.vertices)
    rig.location.z -= lo
    bpy.context.view_layer.update()
    objs = [rig, *rig.children]
    with bpy.context.temp_override(object=rig, active_object=rig, selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return lo


MAX_TEX = 2048


def shrink_textures(rig):
    """MakeHuman ships 4k textures; 2048 px is plenty for a figure seen at a few metres."""
    seen = set()
    for ob in rig.children:
        for slot in ob.material_slots:
            if not slot.material or not slot.material.node_tree:
                continue
            for n in slot.material.node_tree.nodes:
                img = getattr(n, 'image', None)
                if img is None or img.name in seen:
                    continue
                seen.add(img.name)
                w, h = img.size
                if max(w, h) > MAX_TEX:
                    k = MAX_TEX / max(w, h)
                    img.scale(int(w * k), int(h * k))


def export(path, rig):
    shrink_textures(rig)
    bpy.ops.object.select_all(action='DESELECT')
    for o in [rig, *rig.children]:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_skins=True,
        export_def_bones=False, export_draco_mesh_compression_enable=False, export_cameras=False, export_lights=False,
        export_extras=False, export_animations=False, export_morph=False, export_materials='EXPORT',
        export_image_format='WEBP', export_image_quality=88)


def render(variant, rig, out_dir):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 800, 1000
    w = scene.world or bpy.data.worlds.new('World')
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.35, 0.37, 0.4, 1)
    bg.inputs[1].default_value = 0.6
    for n, (rot, e) in {'key': ((0.9, 0, 0.6), 4), 'fill': ((1.1, 0, -0.9), 1.5), 'rim': ((-0.8, 0, 0), 3)}.items():
        L = bpy.data.objects.get('L_' + n) or bpy.data.objects.new('L_' + n, bpy.data.lights.new('L_' + n, 'SUN'))
        if L.name not in scene.collection.objects:
            scene.collection.objects.link(L)
        L.rotation_euler = rot
        L.data.energy = e
    cam = bpy.data.objects.get('ReviewCam') or bpy.data.objects.new('ReviewCam', bpy.data.cameras.new('ReviewCam'))
    if cam.name not in scene.collection.objects:
        scene.collection.objects.link(cam)
    scene.camera = cam
    os.makedirs(out_dir, exist_ok=True)
    eye = rig.data.bones['head'].head_local.z + 0.07
    shots = {'34': (V((1.3, -4.0, 1.1)), V((0, 0, 0.88)), 45), 'side': (V((4.2, 0, 1.0)), V((0, 0, 0.88)), 45),
             'back': (V((-1.5, 4.0, 1.2)), V((0, 0, 0.88)), 45), 'face': (V((0.3, -1.1, eye)), V((0, 0, eye - 0.02)), 85)}
    paths = []
    for tag, (pos, look, lens) in shots.items():
        cam.data.lens = lens
        cam.location = pos
        cam.rotation_euler = (look - pos).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out_dir, f'{variant}-{tag}.png')
        bpy.ops.render.render(write_still=True)
        paths.append(scene.render.filepath)
    return paths


def joints(rig):
    """Rest positions of the joints the client uses (Blender coords), for the report."""
    b = rig.data.bones
    names = ('pelvis', 'spine_01', 'neck_01', 'head', 'upperarm_l', 'lowerarm_l', 'hand_l', 'thigh_l', 'calf_l', 'foot_l', 'ball_l')
    return {n: [round(c, 3) for c in b[n].head_local] for n in names}


def build(variant):
    clear_scene()
    _, rig = create(variant)
    fix_materials(rig)
    bake(rig)
    neutral_rest(rig)
    lift = ground(rig)
    for ob in rig.children:
        ob.name = re.sub(r'\.\d{3}$', '', ob.name.replace(f'{variant}.', ''))
    rig.name = f'{variant}.rig'
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'character_{variant}.blend'))
    export(os.path.join(HERE, f'character_{variant}.glb'), rig)
    repo = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
    deps = bpy.context.evaluated_depsgraph_get()
    tris = sum(sum(len(p.vertices) - 2 for p in o.evaluated_get(deps).data.polygons) for o in rig.children if o.type == 'MESH')
    hi = max((o.matrix_world @ V(c)).z for o in rig.children if o.type == 'MESH' for c in o.bound_box)
    return {'variant': variant, 'height': round(hi, 3), 'ground_shift': round(-lift, 3), 'tris': tris,
            'joints': joints(rig), 'shots': render(variant, rig, os.path.join(repo, 'shots', 'character'))}


REPORT = [build(v) for v in (globals().get('ONLY') or VARIANTS)]
print('CHARACTER_REPORT', REPORT)
