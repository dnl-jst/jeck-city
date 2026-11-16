"""Portraits of the player characters for the avatar choice in the name dialog (apps/client/public/portraits/<variant>.webp).

Headless, from the exported GLBs the game loads (textures embedded; no MPFB needed):
    blender -b --factory-startup --python data/models/character/portraits.py

Head and shoulders, slight three-quarter view, transparent background, 512×512 WebP.
"""
import os

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'apps', 'client', 'public', 'portraits'))
VARIANTS = ('man', 'woman')
SIZE = 512


def portrait(variant):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(HERE, f'character_{variant}.glb'))
    scene = bpy.context.scene
    rig = next(o for o in scene.objects if o.type == 'ARMATURE')
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'WEBP'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.quality = 90
    scene.view_settings.view_transform = 'AgX'
    w = scene.world or bpy.data.worlds.new('World')
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.42, 0.44, 0.5, 1)
    bg.inputs[1].default_value = 0.7
    # warm key from the front left, cool fill, golden rim from behind (the game's lamp-lit night)
    lights = {'key': ((1.05, 0, -0.5), 4.5, (1.0, 0.95, 0.88)), 'fill': ((1.2, 0, 0.9), 1.4, (0.8, 0.86, 1.0)),
              'rim': ((-1.0, 0, 2.6), 5.0, (1.0, 0.8, 0.5))}
    for n, (rot, e, col) in lights.items():
        L = bpy.data.objects.get('P_' + n) or bpy.data.objects.new('P_' + n, bpy.data.lights.new('P_' + n, 'SUN'))
        if L.name not in scene.collection.objects:
            scene.collection.objects.link(L)
        L.rotation_euler = rot
        L.data.energy = e
        L.data.color = col
    for o in scene.objects:
        if o.type == 'LIGHT' and not o.name.startswith('P_'):
            o.hide_render = True
    cam = bpy.data.objects.new('PortraitCam', bpy.data.cameras.new('PortraitCam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    head = rig.matrix_world @ rig.data.bones['head'].head_local
    # framing from the top of the hair: the face a little above the centre, the shoulders at the bottom
    top = max((o.matrix_world @ Vector(c)).z for o in scene.objects if o.type == 'MESH' for c in o.bound_box)
    centre = Vector((head.x, head.y, top - 0.19))
    pos = centre + Vector((0.34, -1.35, 0.04))
    cam.data.lens = 85
    cam.location = pos
    cam.rotation_euler = (centre - pos).to_track_quat('-Z', 'Y').to_euler()
    os.makedirs(OUT, exist_ok=True)
    scene.render.filepath = os.path.join(OUT, f'{variant}.webp')
    bpy.ops.render.render(write_still=True)
    return scene.render.filepath


print('PORTRAITS', [portrait(v) for v in VARIANTS])
