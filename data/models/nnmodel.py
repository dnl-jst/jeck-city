"""Shared helpers for the procedural building models in data/models (run inside Blender).

Geometry is built in a local frame (u, v, z) and placed in the world by Builder.to_object(origin, theta).
Faces get world-scale UVs (Builder.tex_m metres per texture tile) unless given explicitly. Conventions
for the exported models: see README.md next to this file.
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

V = Vector


def _img(name, arr):
    """arr: H×W×3 (or ×4 with alpha) float sRGB in [0,1], row 0 at the bottom → packed Blender image."""
    h, w, c = arr.shape
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, w, h, alpha=c == 4)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :c] = np.clip(arr, 0, 1)
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'PNG' if c == 4 else 'JPEG'  # the glTF exporter keeps PNG for images with alpha
    img.pack()
    return img


def _blur_noise(rng, size, cells):
    """Smooth tileable noise in [-1,1]: bilinear upsampling of a cells×cells random grid."""
    g = rng.uniform(-1, 1, (cells, cells))
    t = np.arange(size) * cells / size
    i0 = np.floor(t).astype(int) % cells
    i1 = (i0 + 1) % cells
    f = t - np.floor(t)
    f = f * f * (3 - 2 * f)
    rows = g[i0] * (1 - f)[:, None] + g[i1] * f[:, None]
    return rows[:, i0] * (1 - f)[None, :] + rows[:, i1] * f[None, :]


def brick_texture(name, palette, mortar, seed, size=512, nx=8, ny=24, soot=0.0):
    rng = np.random.default_rng(seed)
    y = np.arange(size)[:, None].astype(np.float32)
    x = np.arange(size)[None, :].astype(np.float32)
    ch, cw = size / ny, size / nx
    row = np.floor(y / ch).astype(int)
    xo = (x + (row % 2) * cw / 2) % size
    col = np.floor(xo / cw).astype(int)
    ids = (row * nx + col)
    pal = np.array(palette, np.float32)
    cols = pal[rng.integers(0, len(pal), ny * nx)] * rng.uniform(0.88, 1.1, (ny * nx, 1))
    img = cols[ids]
    yy = y - row * ch
    xx = xo - col * cw
    m = (yy < 2.2) | (xx < 2.2)
    img[np.broadcast_to(m, ids.shape)] = mortar
    img += rng.normal(0, 0.018, img.shape)
    img *= (1 + 0.07 * _blur_noise(rng, size, 6))[..., None]
    if soot:
        img *= (1 - soot * (0.5 + 0.5 * _blur_noise(rng, size, 3)))[..., None]
    return _img(name, img)


def slate_texture(name, seed, size=512, rows=8):
    rng = np.random.default_rng(seed)
    img = np.zeros((size, size, 3), np.float32)
    rh = size // rows
    for r in range(rows):
        x = 0
        widths = []
        while x < size:
            w = int(rng.uniform(0.09, 0.15) * size)
            widths.append(min(w, size - x))
            x += w
        x = int((r % 2) * rh * 0.5)
        for w in widths:
            c = np.array([0.20, 0.22, 0.25]) * rng.uniform(0.85, 1.15) + rng.uniform(-0.015, 0.015, 3)
            xs = (np.arange(x, x + w) % size)
            img[r * rh:(r + 1) * rh, xs] = c
            img[r * rh:(r + 1) * rh, xs[0]] = c * 0.55
            x += w
        img[r * rh:r * rh + 3] *= 0.5  # shadow under the row above
    img += rng.normal(0, 0.012, img.shape)
    return _img(name, img)


def material(name, color=(0.5, 0.5, 0.5), rough=0.85, metal=0.0, image=None, emit_image=None, clip=False):
    """Principled material; `clip`: the image's alpha cuts the surface (glTF alphaMode MASK, cutoff 0.5)."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    m.diffuse_color = (*[c ** 2.2 for c in color], 1)  # solid viewport preview
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = (*[c ** 2.2 for c in color], 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if image:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = image
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if clip:  # Round(alpha) is how the glTF exporter recognises alpha clipping
            r = nt.nodes.new('ShaderNodeMath')
            r.operation = 'ROUND'
            nt.links.new(t.outputs['Alpha'], r.inputs[0])
            nt.links.new(r.outputs['Value'], bsdf.inputs['Alpha'])
    if emit_image:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = emit_image
        nt.links.new(t.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    return m


def newell(pts):
    n = V((0, 0, 0))
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        n.x += (p.y - q.y) * (p.z + q.z)
        n.y += (p.z - q.z) * (p.x + q.x)
        n.z += (p.x - q.x) * (p.y + q.y)
    return n.normalized() if n.length > 1e-12 else n


class Builder:
    def __init__(self, mats=None, tex_m=2.0):
        self.tex_m = tex_m  # metres covered by one texture tile (world-scale UVs)
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.mats = mats
        self.slots = []

    def slot(self, name):
        if name not in self.slots:
            self.slots.append(name)
        return self.slots.index(name)

    def face(self, pts, mat, out=None, uvs=None):
        pts = [V(p) for p in pts]
        n = newell(pts)
        if out is not None and n.dot(V(out)) < 0:
            pts.reverse()
            n = -n
            if uvs:
                uvs = list(reversed(uvs))
        f = self.bm.faces.new([self.bm.verts.new(p) for p in pts])
        f.material_index = self.slot(mat)
        if uvs is None:
            h = V((n.x, n.y, 0))
            t = V((-n.y, n.x, 0)).normalized() if h.length > 1e-3 else V((1, 0, 0))
            b = n.cross(t)
            if b.z < 0:
                b = -b
            uvs = [(p.dot(t) / self.tex_m, p.dot(b) / self.tex_m) for p in pts]
        for loop, uv in zip(f.loops, uvs):
            loop[self.uv].uv = uv
        return f

    def to_object(self, name, coll, origin=(0.0, 0.0), theta=0.0):
        """Mesh object at world (origin, z 0), rotated theta (rad) about Z: local u/v axes → world."""
        me = bpy.data.meshes.new(name)
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-4)
        self.bm.to_mesh(me)
        self.bm.free()
        if self.mats:
            for s in self.slots:
                me.materials.append(self.mats[s])
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        ob.location = (origin[0], origin[1], 0)
        ob.rotation_euler = (0, 0, theta)
        return ob


def ccw(poly):
    a = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1]))
    return poly if a > 0 else list(reversed(poly))


def edges(poly):
    """(a, b, tangent, outward normal) for each edge of a CCW polygon."""
    for a, b in zip(poly, poly[1:] + poly[:1]):
        t = (V(b) - V(a)).normalized()
        yield V(a), V(b), t, V((t.y, -t.x))


def prism(B, poly, z0, z1, mat, top=None, bottom=False, side_mats=None):
    poly = ccw([V(p).to_2d() for p in poly])
    for i, (a, b, t, n) in enumerate(edges(poly)):
        m = side_mats[i] if side_mats else mat
        B.face([(a.x, a.y, z0), (b.x, b.y, z0), (b.x, b.y, z1), (a.x, a.y, z1)], m, out=(n.x, n.y, 0))
    if top:
        B.face([(p.x, p.y, z1) for p in poly], top, out=(0, 0, 1))
    if bottom:
        B.face([(p.x, p.y, z0) for p in poly], mat, out=(0, 0, -1))


def box(B, u0, u1, v0, v1, z0, z1, mat, top=None):
    prism(B, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], z0, z1, mat, top=top or mat)


def line_x(p, d, q, e):
    """Intersection of lines p+s·d and q+t·e (2D)."""
    den = d.x * e.y - d.y * e.x
    s = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den
    return p + d * s


def wall_frame(a, b):
    a, b = V(a).to_2d(), V(b).to_2d()
    t = (b - a).normalized()
    return a, t, V((t.y, -t.x))


def on_wall(a, t, n, s, z, d):
    p = a + t * s + n * d
    return (p.x, p.y, z)


def flat(B, a, t, n, s, w, z0, z1, mat, d=0.05, uvs=None):
    """Rectangle on a wall frame, centred s along the wall."""
    B.face([on_wall(a, t, n, s - w / 2, z0, d), on_wall(a, t, n, s + w / 2, z0, d),
            on_wall(a, t, n, s + w / 2, z1, d), on_wall(a, t, n, s - w / 2, z1, d)], mat, out=(n.x, n.y, 0), uvs=uvs)


def rect_window(B, a, b, s, w, z0, z1, mat='GlassModern', frame='Frame', panes=1, sill=True):
    a2, t, n = wall_frame(a, b)
    flat(B, a2, t, n, s, w, z0, z1, mat, 0.04)
    for k in range(1, panes):
        flat(B, a2, t, n, s - w / 2 + w * k / panes, 0.08, z0, z1, frame, 0.06)
    for x in (s - w / 2, s + w / 2):
        flat(B, a2, t, n, x, 0.08, z0, z1, frame, 0.06)
    flat(B, a2, t, n, s, w, z1 - 0.08, z1, frame, 0.06)
    if sill:
        flat(B, a2, t, n, s, w + 0.2, z0 - 0.12, z0, 'Stone', 0.09)



def reset_collection(name):
    """Removes collection `name` with its objects (and orphan meshes) and returns a fresh, linked one."""
    for c in list(bpy.data.collections):
        if c.name == name:
            for o in list(c.objects):
                bpy.data.objects.remove(o, do_unlink=True)
            bpy.data.collections.remove(c)
    for m in list(bpy.data.meshes):
        if m.users == 0:
            bpy.data.meshes.remove(m)
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    return coll


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def export_glb(path, objects):
    """glTF binary of `objects` (world transforms baked by the pipeline), JPEG textures, no Draco."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_apply=True, export_yup=True, export_image_format='JPEG', export_jpeg_quality=85,
        export_draco_mesh_compression_enable=False, export_cameras=False, export_lights=False,
        export_extras=False, export_animations=False, export_materials='EXPORT')


def grid_window_texture(name, cols, rows, arch=0.0, frame=(0.93, 0.93, 0.91), bar=0.03, outer=0.07, glass=(0.08, 0.10, 0.12),
                        lit=False, curtains=False, seed=0, w=128, h=256):
    """Window as one image: a frame with cols × rows panes. arch > 0: a segmental head (its rise as a share of the
    height) – the corners above it are transparent (use the material with clip=True). curtains: net curtains or a
    blind behind the glass (flats). lit → the emission image (warm panes, black frame). Row 0 is the bottom."""
    rng = np.random.default_rng(seed * 977 + cols * 31 + rows)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    yy, xx = (yy + 0.5) / h, (xx + 0.5) / w
    top = 1 - arch * (2 * xx - 1) ** 2  # the head's line
    k = w / h  # frame widths are given in shares of the width
    pane = (np.floor(xx * cols) + cols * np.floor(np.clip(yy / top, 0, 0.999) * rows)).astype(int)
    tone = rng.uniform(0.75, 1.3, cols * rows).astype(np.float32)[pane]
    img = np.array(glass, np.float32) * tone[..., None] + (0.14 * yy)[..., None] * np.array((0.8, 0.9, 1.0), np.float32)
    img += (np.clip(1 - np.abs((xx + yy * 0.5) - 0.8) * 6, 0, 1) * 0.10)[..., None]
    if curtains:
        kind = rng.integers(0, 3)
        cur = (xx < 0.24) | (xx > 0.76) if kind == 0 else (yy > rng.uniform(0.45, 0.8)) if kind == 1 else np.zeros_like(xx, bool)
        fold = 0.9 + 0.1 * np.cos(xx * 110)
        img = np.where(cur[..., None], np.array((0.82, 0.80, 0.74), np.float32) * fold[..., None], img)
    if lit:
        warm = np.array((1.0, 0.80, 0.50), np.float32) * (0.35 + 0.3 * rng.uniform(0.6, 1.0, cols * rows).astype(np.float32)[pane])[..., None]
        img = warm * (0.75 + 0.25 * yy)[..., None]
    fr = (xx < outer) | (xx > 1 - outer) | (yy < outer * k) | (yy > top - outer * k)
    for c in range(1, cols):
        fr |= np.abs(xx - c / cols) < bar / 2
    for r in range(1, rows):
        fr |= np.abs(yy - top * r / rows) < bar * k / 2
    img[fr] = (0.0, 0.0, 0.0) if lit else frame
    if not lit:
        # the reveal's shadow along the top and one side: the pane looks set back
        shade = np.clip(1 - (top - yy) / (0.05 * k), 0, 1) * 0.35 + np.clip(1 - xx / 0.05, 0, 1) * 0.2
        img *= (1 - shade)[..., None]
        img += rng.normal(0, 0.006, img.shape)
    if arch > 0:
        img = np.concatenate([img, (yy <= top).astype(np.float32)[..., None]], axis=2)
    return _img(name, img)


def see_through(m, alpha):
    """Makes material m clear glass (glTF alphaMode BLEND) with this opacity."""
    m.node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = alpha
    m.surface_render_method = 'BLENDED'
    m.diffuse_color = (*m.diffuse_color[:3], alpha)
    return m
