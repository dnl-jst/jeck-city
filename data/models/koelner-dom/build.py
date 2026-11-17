"""Kölner Dom with the Domtreppe: procedural Blender model for the building override DENW37AL1000qmxq.

Headless:
    cd data/models/koelner-dom && blender -b --factory-startup --python-expr \
      "P='$PWD/build.py'; exec(open(P).read(), {'__file__': P})"
It rebuilds the collection KOELNER_DOM, saves koelner-dom.blend and exports koelner-dom.glb next to this file.

Frame (see data/models/README.md): metres, Blender Z up, X = game x (east), Y = north (= -game z). The object sits at
the centre of the crossing; the cathedral's axis runs due east in the UTM grid (LOD2), so there is no rotation.
Local axes: u east along the nave, v north, z up from the LOD2 base (49.49 m NHN); the floor and the Domplatte lie
F = 5.8 m above it.

Sources: plan "Kölner Dom Grundriss schematisch" (Wikimedia Commons, to scale: 0.0683 m/px, crossing at px 635/975),
LOD2 DENW37AL1000qmxq (axis, crossing, tower axes at v ±16), DGM1 (Domplatte, Domtreppe), photos of the west front,
the south side and the north transept with the stairs (Commons). Heights: towers 157.4 m, vault 43.4 m, roof ridge
61.1 m, crossing spire 109 m above the floor.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from nnmodel import (V, Builder, _blur_noise, _img, brick_texture, ccw, edges, export_glb, material,  # noqa: E402
                     on_wall, prism, reset_collection, tris, wall_frame)

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'koelner-dom'
ORIGIN = (355.5, -2432.8)  # crossing centre, Blender X/Y
SINK = -0.3
F = 5.8            # floor / Domplatte level
TEX_M = 6.0        # one texture tile covers 6 m × 6 m

# plan
VC = 7.85          # central vessel: pier axis
VW = 8.6           # clerestory wall, outer face
VA = 15.7          # inner pier rows (between inner and outer aisle)
VO = 23.6          # outer aisle wall
NAVE_PIERS = [-15.0, -22.9, -30.7, -38.6, -46.4]
CHOIR_PIERS = [14.0, 22.2, 30.1, 37.9]
TU0, TU1 = -72.4, -50.3        # towers: west face, east face
TV0, TV1 = 6.4, 27.8           # towers: inner and outer face (|v|)
TC = ((TU0 + TU1) / 2, (TV0 + TV1) / 2)  # tower centre (u, |v|)
TRU = 14.0                     # transept: outer walls at u ±14
TRV = 38.9                     # transept fronts at v ±38.9
APSE_U = 37.9                  # apse centre
CHAP_R = 23.5                  # chapel ring

# heights above the floor
Z_AISLE = 24.5     # aisle walls
Z_EAVE = 46.5      # clerestory
Z_RIDGE = 61.1
Z_S1, Z_S2, Z_S3, Z_OCT, Z_SPIRE, Z_TOP = 27.5, 56.0, 95.0, 108.0, 152.5, 157.4


def z(h):
    return F + h


# ---------------------------------------------------------------- textures

def ashlar(name, seed, light=1.0):
    # weathered trachyte and sandstone: dark grey-brown, low contrast between blocks (strong contrast reads as a
    # chequerboard up close), a few lighter replaced blocks
    pal = [(0.44, 0.41, 0.37), (0.41, 0.38, 0.35), (0.47, 0.44, 0.39), (0.39, 0.37, 0.34), (0.50, 0.46, 0.41),
           (0.43, 0.40, 0.36), (0.58, 0.54, 0.47)]
    pal = [tuple(c * light for c in p) for p in pal]
    return brick_texture(name, pal, (0.47 * light, 0.44 * light, 0.40 * light), seed, size=512, nx=6, ny=10, soot=0.22)


def _arch_mask(xx, yy, x0, x1, ys, thick=None):
    """Pointed arch (equilateral) over the span x0..x1 springing at ys (y up): inside mask, or its outline if thick."""
    w = x1 - x0
    inside_l = (xx - x0) ** 2 + (yy - ys) ** 2 <= w * w
    inside_r = (xx - x1) ** 2 + (yy - ys) ** 2 <= w * w
    m = ((yy <= ys) | (inside_l & inside_r)) & (xx >= x0) & (xx <= x1)
    if thick is None:
        return m
    inner = _arch_mask(xx, yy, x0 + thick, x1 - thick, ys - thick * 0.3)
    return m & ~inner


def panel_texture(name, seed):
    """Blind tracery: three recessed lancet panels per 6 m tile on dark ashlar (towers, buttresses, gables)."""
    size = 512
    base = np.array(ashlar(name + '_base', seed).pixels[:]).reshape(size, size, 4)[..., :3].copy()
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    img = base
    pw = size / 3
    for k in range(3):
        x0, x1 = k * pw + 10, (k + 1) * pw - 10
        ys = size * 0.70
        rec = _arch_mask(xx, yy, x0, x1, ys) & (yy > 14)
        img[rec] *= 0.62
        line = _arch_mask(xx, yy, x0, x1, ys, thick=5) & (yy > 14)
        img[line] = img[line] * 0.4 + 0.18
        mid = (np.abs(xx - (x0 + x1) / 2) < 2.5) & (yy > 14) & (yy < ys + 20)
        img[mid] = img[mid] * 0.4 + 0.16
        tre = ((xx - (x0 + x1) / 2) ** 2 + (yy - (ys + 52)) ** 2 < 22 ** 2) & ((xx - (x0 + x1) / 2) ** 2 + (yy - (ys + 52)) ** 2 > 16 ** 2)
        img[tre] = img[tre] * 0.4 + 0.16
    img[(yy < 12)] *= 0.75
    bpy.data.images.remove(bpy.data.images[name + '_base'])
    return _img(name, img)


def window_texture(name, seed, lights=4, emit=False):
    """Tracery window for a lancet face with uvs 0..1 (1:4): stone mullions, lancet heads, roses; glass between."""
    rng = np.random.default_rng(seed)
    w, h = 256, 1024
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    pal = np.array([[0.10, 0.16, 0.40], [0.38, 0.08, 0.07], [0.45, 0.33, 0.10], [0.10, 0.25, 0.14], [0.22, 0.22, 0.26]],
                   np.float32)
    cells = pal[rng.integers(0, len(pal), (h // 24 + 1, w // 16 + 1))] * rng.uniform(0.7, 1.2, (h // 24 + 1, w // 16 + 1, 1))
    glass = cells[(yy // 24).astype(int), (xx // 16).astype(int)]
    glass = glass * 0.55 + 0.45 * np.array([0.08, 0.09, 0.11])
    stone = np.array([0.40, 0.37, 0.33], np.float32)
    mask = np.zeros((h, w), bool)
    lw = w / lights
    ys = h * 0.62
    for k in range(lights):
        x0, x1 = k * lw + 6, (k + 1) * lw - 6
        mask |= ~_arch_mask(xx, yy, x0, x1, ys + (x1 - x0) * 0.0) & (xx >= k * lw) & (xx < (k + 1) * lw) & (yy < ys + lw * 0.9)
    # roses in the head
    cx, r = w / 2, w * 0.30
    for cy, rr in ((h * 0.80, r), (h * 0.69, r * 0.55)):
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        mask |= (np.abs(d - rr) < 5) | ((d < rr) & (np.abs(np.arctan2(yy - cy, xx - cx) % (np.pi / 4) - np.pi / 8) < 0.06))
    mask |= (xx < 6) | (xx > w - 7) | (yy < 6)
    # horizontal saddle bars
    bars = (yy % 48 < 2) & (yy < ys)
    img = np.where(mask[..., None], stone, glass)
    img[bars & ~mask] *= 0.35
    img += rng.normal(0, 0.01, img.shape)
    if emit:
        e = np.where(mask[..., None], 0.0, glass * 1.6)
        return _img(name, img), _img(name + '_emit', e)
    return _img(name, img)


def openwork_texture(name, seed):
    """Spire tracery: ashlar with quatrefoil and trefoil openings (alpha 0), 6 m tile."""
    size = 512
    base = np.array(ashlar(name + '_base', seed, 1.05).pixels[:]).reshape(size, size, 4)[..., :3].copy()
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    alpha = np.ones((size, size), np.float32)
    n = 4
    c = size / n
    for i in range(n):
        for j in range(n):
            cx, cy = (i + 0.5) * c, (j + 0.5) * c
            r = c * 0.17
            hole = np.zeros((size, size), bool)
            for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r)):
                hole |= (xx - cx - dx) ** 2 + (yy - cy - dy) ** 2 < (r * 1.05) ** 2
            alpha[hole] = 0
            ring = ((xx - cx) ** 2 + (yy - cy) ** 2 < (c * 0.47) ** 2) & ((xx - cx) ** 2 + (yy - cy) ** 2 > (c * 0.42) ** 2)
            base[ring] *= 0.6
    img = np.concatenate([base, alpha[..., None]], axis=2)
    bpy.data.images.remove(bpy.data.images[name + '_base'])
    return _img(name, img)


def balustrade_texture(name):
    """One balustrade field (uvs 0..1 per 1.2 m): rails top and bottom, a quatrefoil opening (alpha 0)."""
    w, h = 128, 128
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    col = np.ones((h, w, 3), np.float32) * np.array([0.40, 0.37, 0.33])
    alpha = np.ones((h, w), np.float32)
    cx, cy, r = w / 2, h * 0.5, w * 0.17
    hole = np.zeros((h, w), bool)
    for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r)):
        hole |= (xx - cx - dx) ** 2 + (yy - cy - dy) ** 2 < (r * 1.1) ** 2
    alpha[hole & (yy > 18) & (yy < h - 22)] = 0
    col[(yy < 16) | (yy > h - 20)] *= 0.85
    return _img(name, np.concatenate([col, alpha[..., None]], axis=2))


def lead_texture(name, seed):
    rng = np.random.default_rng(seed)
    size = 512
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    img = np.ones((size, size, 3), np.float32) * np.array([0.50, 0.53, 0.55])
    img *= (1 + 0.08 * _blur_noise(rng, size, 5))[..., None]
    seam = (xx % (size / 10)) < 3  # standing seams every 0.6 m
    img[seam] *= 0.72
    img[(yy % (size / 3)) < 2] *= 0.85
    img += rng.normal(0, 0.012, img.shape)
    return _img(name, img)


def make_materials():
    stone = ashlar('tex_dom_ashlar', 21)
    # floodlit at night: the emission texture is the stone itself, warm
    glow = np.array(stone.pixels[:]).reshape(512, 512, 4)[..., :3] * np.array([0.55, 0.45, 0.30])
    stone_emit = _img('tex_dom_ashlar_emit', glow)
    panel = panel_texture('tex_dom_panel', 22)
    pglow = np.array(panel.pixels[:]).reshape(512, 512, 4)[..., :3] * np.array([0.55, 0.45, 0.30])
    panel_emit = _img('tex_dom_panel_emit', pglow)
    win, win_emit = window_texture('tex_dom_window', 23, emit=True)
    belfry = window_texture('tex_dom_belfry', 24, lights=2)
    open_ = openwork_texture('tex_dom_openwork', 25)
    bal = balustrade_texture('tex_dom_balustrade')
    lead = lead_texture('tex_dom_lead', 26)
    trim = ashlar('tex_dom_trim', 28, 1.3)
    tglow = np.array(trim.pixels[:]).reshape(512, 512, 4)[..., :3] * np.array([0.60, 0.50, 0.34])
    trim_emit = _img('tex_dom_trim_emit', tglow)
    mats = {
        'Stone': material('Stone', image=stone, emit_image=stone_emit, rough=0.92),
        'Panel': material('Panel', image=panel, emit_image=panel_emit, rough=0.92),
        'Trim': material('Trim', image=trim, emit_image=trim_emit, rough=0.85),
        'Window': material('Window', image=win, emit_image=win_emit, rough=0.2),
        'Belfry': material('Belfry', image=belfry, rough=0.6),
        'Openwork': material('Openwork', image=open_, emit_image=stone_emit, rough=0.9, clip=True),
        'Balustrade': material('Balustrade', image=bal, rough=0.9, clip=True),
        'Lead': material('Lead', image=lead, rough=0.55, metal=0.35),
        'Metal': material('Metal', (0.30, 0.36, 0.34), 0.5, 0.6),
        'Gold': material('Gold', (0.80, 0.62, 0.25), 0.35, 1.0),
        'Door': material('Door', (0.16, 0.13, 0.10), 0.7),
        'Steps': material('Steps', (0.66, 0.64, 0.60), 0.85),  # light granite, plain: a texture tile per step reads as noise
    }
    for m in mats.values():
        m.use_backface_culling = False
    return mats


# ---------------------------------------------------------------- primitives

def quad(B, a, b, z0, z1, mat, out, d=0.0, uvs=None):
    """Vertical rectangle on the segment a→b (2D), offset d along out."""
    o = V((out[0], out[1])).normalized() * d
    a, b = V(a) + o, V(b) + o
    B.face([(a.x, a.y, z0), (b.x, b.y, z0), (b.x, b.y, z1), (a.x, a.y, z1)], mat, out=(out[0], out[1], 0), uvs=uvs)


def boxm(B, u0, u1, v0, v1, z0, z1, mat, top=None, bottom=False):
    prism(B, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], z0, z1, mat, top=top or mat, bottom=bottom)


def pyramid(B, poly, z0, apex, mat):
    poly = ccw([V(p).to_2d() for p in poly])
    for a, b, t, n in edges(poly):
        B.face([(a.x, a.y, z0), (b.x, b.y, z0), apex], mat, out=(n.x, n.y, 0.4))


def poly_n(cu, cv, apothem, n, rot=None):
    rot = 180 / n if rot is None else rot
    r = apothem / math.cos(math.pi / n)
    return [(cu + r * math.cos(math.radians(rot + 360 * k / n)), cv + r * math.sin(math.radians(rot + 360 * k / n)))
            for k in range(n)]


def finial(B, cu, cv, zb, s, mat='Trim'):
    """Kreuzblume: a small cross of two crossed leaves on top of a spire tip."""
    B.face([(cu - s, cv, zb), (cu + s, cv, zb), (cu + s * 0.4, cv, zb + s * 1.6), (cu - s * 0.4, cv, zb + s * 1.6)], mat, out=(0, 1, 0))
    B.face([(cu, cv - s, zb), (cu, cv + s, zb), (cu, cv + s * 0.4, zb + s * 1.6), (cu, cv - s * 0.4, zb + s * 1.6)], mat, out=(1, 0, 0))
    pyramid(B, poly_n(cu, cv, s * 0.25, 4, 45), zb + s * 1.6, (cu, cv, zb + s * 2.6), mat)


def pinnacle(B, cu, cv, z0, h, w, mat='Trim', shaft_mat='Panel'):
    """Gothic pinnacle: square shaft (w), small gables, slender pyramid with a finial."""
    hs = h * 0.38
    sq = poly_n(cu, cv, w / 2, 4, 45)
    prism(B, sq, z0, z0 + hs, shaft_mat)
    for a, b, t, n in edges(ccw([V(p) for p in sq])):  # little gables on the four faces
        m = (a + b) / 2 + n * 0.02
        B.face([(a.x + n.x * 0.02, a.y + n.y * 0.02, z0 + hs), (b.x + n.x * 0.02, b.y + n.y * 0.02, z0 + hs),
                (m.x, m.y, z0 + hs + w * 0.9)], mat, out=(n.x, n.y, 0))
    pyramid(B, poly_n(cu, cv, w * 0.42, 4, 45), z0 + hs, (cu, cv, z0 + h), mat)
    finial(B, cu, cv, z0 + h - w * 0.2, w * 0.28, mat)


def lancet(B, a, b, s, w, z0, h, mat='Window', frame='Trim', d=0.06, seg=6, reveal=0.6):
    """Pointed window on the wall a→b (outward normal on the right), centred s from a, recessed by `reveal`."""
    a, t, n = wall_frame(a, b)

    def outline(hw, zb, ht):
        r = 2 * hw
        zs = zb + ht - r * math.sqrt(3) / 2
        pts = [(-hw, zb), (hw, zb), (hw, zs)]
        for k in range(1, seg):
            ang = math.radians(60 * k / seg)
            pts.append((-hw + r * math.cos(ang), zs + r * math.sin(ang)))
        pts.append((0, zb + ht))
        for k in range(seg - 1, 0, -1):
            ang = math.radians(60 * k / seg)
            pts.append((hw - r * math.cos(ang), zs + r * math.sin(ang)))
        pts.append((-hw, zs))
        return pts

    inner = outline(w / 2, z0, h)
    uvs = [((x + w / 2) / w, (zz - z0) / h) for x, zz in inner]
    B.face([on_wall(a, t, n, s + x, zz, d) for x, zz in inner], mat, out=(n.x, n.y, 0), uvs=uvs)
    # the walls are solid, so the depth comes from a deep moulded frame standing out from the wall: inner jambs
    # (reveal) and a splayed outer moulding
    fw = max(0.3, w * 0.07)
    outer = outline(w / 2 + fw, z0 - fw, h + 2 * fw)
    for i in range(len(inner)):
        j = (i + 1) % len(inner)
        p, q = inner[i], inner[j]
        if i == 0:
            continue
        B.face([on_wall(a, t, n, s + p[0], p[1], d), on_wall(a, t, n, s + q[0], q[1], d),
                on_wall(a, t, n, s + q[0], q[1], d + reveal), on_wall(a, t, n, s + p[0], p[1], d + reveal)], frame)
        B.face([on_wall(a, t, n, s + p[0], p[1], d + reveal), on_wall(a, t, n, s + q[0], q[1], d + reveal),
                on_wall(a, t, n, s + outer[j][0], outer[j][1], d + reveal * 0.4),
                on_wall(a, t, n, s + outer[i][0], outer[i][1], d + reveal * 0.4)], frame)
        B.face([on_wall(a, t, n, s + outer[i][0], outer[i][1], d + reveal * 0.4),
                on_wall(a, t, n, s + outer[j][0], outer[j][1], d + reveal * 0.4),
                on_wall(a, t, n, s + outer[j][0], outer[j][1], d), on_wall(a, t, n, s + outer[i][0], outer[i][1], d)], frame)
    # sill
    B.face([on_wall(a, t, n, s - w / 2 - fw, z0, d), on_wall(a, t, n, s + w / 2 + fw, z0, d),
            on_wall(a, t, n, s + w / 2 + fw, z0, d + reveal), on_wall(a, t, n, s - w / 2 - fw, z0, d + reveal)], frame, out=(0, 0, 1))
    return n


def wimperg(B, a, b, s, w, z0, h, d=0.35, depth=0.5):
    """Gable over an opening: thin triangular slab of blind tracery in front of the wall, pinnacles at its feet."""
    a, t, n = wall_frame(a, b)
    p0, p1 = on_wall(a, t, n, s - w / 2, z0, d), on_wall(a, t, n, s + w / 2, z0, d)
    ap = on_wall(a, t, n, s, z0 + h, d)
    q0, q1 = on_wall(a, t, n, s - w / 2, z0, d - depth), on_wall(a, t, n, s + w / 2, z0, d - depth)
    aq = on_wall(a, t, n, s, z0 + h, d - depth)
    uv = [(0, 0), (w / TEX_M, 0), (w / 2 / TEX_M, h / TEX_M)]
    B.face([p0, p1, ap], 'Panel', out=(n.x, n.y, 0), uvs=uv)
    B.face([p1, q1, aq, ap], 'Trim')
    B.face([q0, p0, ap, aq], 'Trim')
    # raking mouldings standing out in front of the gable, with crockets along them
    mw = max(0.25, w * 0.06)
    for x0, x1 in ((s - w / 2, s), (s + w / 2, s)):
        z_0, z_1 = z0, z0 + h
        e0 = on_wall(a, t, n, x0, z_0, d + 0.25)
        e1 = on_wall(a, t, n, x1, z_1, d + 0.25)
        f0 = on_wall(a, t, n, x0 + (mw if x0 < s else -mw), z_0, d + 0.25)
        f1 = on_wall(a, t, n, x1, z_1 - mw * 1.8, d + 0.25)
        B.face([e0, f0, f1, e1], 'Trim', out=(n.x, n.y, 0))
        g0 = on_wall(a, t, n, x0, z_0, d)
        g1 = on_wall(a, t, n, x1, z_1, d)
        B.face([g0, e0, e1, g1], 'Trim')
        k = max(2, int(h / 1.6))
        for i in range(1, k):
            f = i / k
            cx = x0 + (x1 - x0) * f
            cz = z_0 + (z_1 - z_0) * f
            c = on_wall(a, t, n, cx, cz, d + 0.3)
            pyramid(B, poly_n(c[0], c[1], 0.14 + w * 0.01, 4, 45), cz, (c[0] + n.x * 0.35, c[1] + n.y * 0.35, cz + 0.55), 'Trim')
    finial(B, ap[0], ap[1], ap[2] - 0.2, max(0.35, w * 0.08))
    for x in (s - w / 2, s + w / 2):
        c = on_wall(a, t, n, x, 0, d - depth / 2)
        pinnacle(B, c[0], c[1], z0 - 0.5, min(9.0, h * 0.75), max(0.6, w * 0.12))


def balustrade(B, a, b, z0, h=1.2, out=None, d=0.0):
    """Open balustrade along a→b (both faces, alpha-clipped quatrefoils), stone rail on top."""
    a, t, n = wall_frame(a, b)
    L = (b - a).length if isinstance(b, V) else (V(b).to_2d() - a).length
    if out is not None:
        n = V(out).to_2d().normalized()
    p, q = a + n * d, a + t * L + n * d
    k = max(1, round(L / h))
    uv = [(0, 0), (k, 0), (k, 1), (0, 1)]
    B.face([(p.x, p.y, z0), (q.x, q.y, z0), (q.x, q.y, z0 + h), (p.x, p.y, z0 + h)], 'Balustrade', out=(n.x, n.y, 0), uvs=uv)
    r0, r1 = p - n * 0.15, q - n * 0.15
    B.face([(p.x, p.y, z0 + h), (q.x, q.y, z0 + h), (r1.x, r1.y, z0 + h), (r0.x, r0.y, z0 + h)], 'Stone', out=(0, 0, 1))


def flyer(B, p0, z0, p1, z1, w=0.9, th=0.9):
    """Flying buttress: an inclined slab from (p0, z0) to (p1, z1), with a pierced top (crockets omitted)."""
    p0, p1 = V(p0), V(p1)
    t = (p1 - p0).normalized()
    s = V((-t.y, t.x)) * (w / 2)
    a0, a1, b0, b1 = p0 - s, p0 + s, p1 - s, p1 + s
    B.face([(a0.x, a0.y, z0), (b0.x, b0.y, z1), (b0.x, b0.y, z1 - th), (a0.x, a0.y, z0 - th)], 'Stone')
    B.face([(a1.x, a1.y, z0), (a1.x, a1.y, z0 - th), (b1.x, b1.y, z1 - th), (b1.x, b1.y, z1)], 'Stone')
    B.face([(a0.x, a0.y, z0), (a1.x, a1.y, z0), (b1.x, b1.y, z1), (b0.x, b0.y, z1)], 'Stone', out=(0, 0, 1))
    B.face([(a0.x, a0.y, z0 - th), (b0.x, b0.y, z1 - th), (b1.x, b1.y, z1 - th), (a1.x, a1.y, z0 - th)], 'Stone', out=(0, 0, -1))


def pier(B, cu, cv, du, dv, z0, z1, pin_h, mat='Panel'):
    """Buttress pier (box centred at cu, cv), stone cap, pinnacle on top."""
    boxm(B, cu - du / 2, cu + du / 2, cv - dv / 2, cv + dv / 2, z0, z1, mat, top='Stone')
    pinnacle(B, cu, cv, z1, pin_h, min(du, dv) * 0.8)


def gable_roof(B, u0, u1, hw, ze, zr, axis='u', c=0.0, end0=True, end1=True):
    """Lead roof over the rectangle along `axis` (half width hw about c), eave ze, ridge zr; optional stone gables."""
    if axis == 'u':
        P = lambda along, across, zz: (along, c + across, zz)
        out_l, out_r, oe0, oe1 = (0, 1, 1), (0, -1, 1), (-1, 0, 0), (1, 0, 0)
    else:
        P = lambda along, across, zz: (c + across, along, zz)
        out_l, out_r, oe0, oe1 = (1, 0, 1), (-1, 0, 1), (0, -1, 0), (0, 1, 0)
    o = 0.4
    B.face([P(u0, hw + o, ze - o * 1.6), P(u1, hw + o, ze - o * 1.6), P(u1, 0, zr), P(u0, 0, zr)], 'Lead', out=out_l)
    B.face([P(u0, -hw - o, ze - o * 1.6), P(u1, -hw - o, ze - o * 1.6), P(u1, 0, zr), P(u0, 0, zr)], 'Lead', out=out_r)
    for u, e, oe in ((u0, end0, oe0), (u1, end1, oe1)):
        if e:
            B.face([P(u, -hw, ze), P(u, hw, ze), P(u, 0, zr)], 'Stone', out=oe)
    # ridge crest
    B.face([P(u0, 0, zr), P(u1, 0, zr), P(u1, 0, zr + 0.6), P(u0, 0, zr + 0.6)], 'Metal')


# ---------------------------------------------------------------- the cathedral

def side_bays(B, bays, sgn, transept_side=False):
    """Aisles, clerestory and buttressing on one side (sgn ±1) for bays between consecutive pier positions."""
    out = (0, sgn)
    wall_o = lambda u0, u1: ((u1, sgn * VO), (u0, sgn * VO)) if sgn > 0 else ((u0, sgn * VO), (u1, sgn * VO))
    wall_c = lambda u0, u1: ((u1, sgn * VW), (u0, sgn * VW)) if sgn > 0 else ((u0, sgn * VW), (u1, sgn * VW))
    for u0, u1 in zip(bays, bays[1:]):
        lo, hi = min(u0, u1), max(u0, u1)
        mid = (lo + hi) / 2
        # outer aisle wall and its window with a gable over it
        a, b = wall_o(lo, hi)
        quad(B, a, b, SINK, z(Z_AISLE), 'Stone', out)
        lancet(B, a, b, (hi - lo) / 2, 4.2, z(4.5), 14.5)
        wimperg(B, a, b, (hi - lo) / 2, 5.4, z(Z_AISLE - 3.5), 9.0)
        balustrade(B, V(a), V(b), z(Z_AISLE), out=out)
        # aisle roof: lean-to from the clerestory to the outer wall
        B.face([(lo, sgn * (VO + 0.3), z(Z_AISLE)), (hi, sgn * (VO + 0.3), z(Z_AISLE)),
                (hi, sgn * VW, z(Z_AISLE + 3.2)), (lo, sgn * VW, z(Z_AISLE + 3.2))], 'Lead', out=(0, sgn, 1))
        # clerestory
        a, b = wall_c(lo, hi)
        quad(B, a, b, z(Z_AISLE + 3.0), z(Z_EAVE), 'Stone', out)
        lancet(B, a, b, (hi - lo) / 2, 5.0, z(28.5), 15.5)
        wimperg(B, a, b, (hi - lo) / 2, 5.6, z(Z_EAVE - 3.0), 7.0, d=0.3)
        balustrade(B, V(a), V(b), z(Z_EAVE), out=out)
    for u in bays:
        # outer pier with a pinnacle, flyers to the intermediate pier and on to the clerestory
        pier(B, u, sgn * (VO + 1.6), 2.0, 3.2, SINK, z(31.0), 11.0)
        pier(B, u, sgn * VA, 1.4, 2.2, z(Z_AISLE + 1.0), z(37.0), 9.0)
        for zz in (z(29.5), z(25.5)):
            flyer(B, (u, sgn * (VO + 0.1)), zz, (u, sgn * (VA + 1.1)), zz + 4.5)
        for zz in (z(41.5), z(36.0)):
            flyer(B, (u, sgn * (VA - 1.1)), zz - 4.0, (u, sgn * VW), zz)
        pinnacle(B, u, sgn * (VW + 0.4), z(Z_EAVE), 4.5, 0.8)


def central_vessel(B):
    # clerestory gable roof over nave (from the towers) and choir straight bays; the transept crosses it
    gable_roof(B, TU1, APSE_U, VW, z(Z_EAVE), z(Z_RIDGE), end0=False, end1=False)
    gable_roof(B, -TRV + 0.5, TRV - 0.5, VW, z(Z_EAVE), z(Z_RIDGE), axis='v', end0=True, end1=True)


def transept_front(B, sgn):
    """North (sgn 1) or south (sgn -1) transept front: three portals, a great window, a gable, two flanking towers."""
    v = sgn * TRV
    W = TRU
    a, b = ((W, v), (-W, v)) if sgn > 0 else ((-W, v), (W, v))
    out = (0, sgn)
    # end walls of the transept aisles and the front itself
    quad(B, a, b, SINK, z(Z_EAVE), 'Panel', out)
    for u in (-W, W):
        side = (-1 if u < 0 else 1)
        aa, bb = ((u, sgn * VO), (u, v)) if (sgn > 0) == (u > 0) else ((u, v), (u, sgn * VO))
        quad(B, aa, bb, SINK, z(Z_AISLE), 'Stone', (side, 0))
        lancet(B, aa, bb, (TRV - VO) / 2, 4.0, z(4.5), 14.5)
        balustrade(B, V(aa), V(bb), z(Z_AISLE), out=(side, 0))
        # transept aisle roofs (u ±(VW..W))
        u_in = side * VW
        B.face([(u + side * 0.3, sgn * VO, z(Z_AISLE)), (u + side * 0.3, v, z(Z_AISLE)),
                (u_in, v, z(Z_AISLE + 3.2)), (u_in, sgn * VO, z(Z_AISLE + 3.2))], 'Lead', out=(side, 0, 1))
        cl = ((u_in, sgn * (VO - 0.0)), (u_in, v)) if (sgn > 0) == (u > 0) else ((u_in, v), (u_in, sgn * VO))
        quad(B, cl[0], cl[1], z(Z_AISLE + 3.0), z(Z_EAVE), 'Stone', (side, 0))
        mid = (VO + TRV) / 2
        lancet(B, cl[0], cl[1], (TRV - VO) / 2, 5.0, z(28.5), 15.5)
        # flanking stair towers / buttress towers with tall pinnacles
        pier(B, side * (W - 1.6), v + sgn * 1.4, 4.4, 4.2, SINK, z(52.0), 18.0)
        pier(B, side * VW, v + sgn * 1.6, 3.4, 3.4, SINK, z(Z_EAVE + 4.0), 16.0)
    # portals
    L = 2 * W
    for s, w, h in ((L / 2, 6.4, 14.0), (L / 2 - 8.6, 4.0, 10.0), (L / 2 + 8.6, 4.0, 10.0)):
        n = lancet(B, a, b, s, w, z(0.0), h, mat='Door', reveal=1.6)
        wimperg(B, a, b, s, w + 1.6, z(h - 1.0), h * 0.85, d=0.5)
    # great window and the gable above
    lancet(B, a, b, L / 2, 11.5, z(24.5), 24.0)
    aa, t, n = wall_frame(a, b)
    ap = on_wall(aa, t, n, L / 2, z(68.5), 0)
    l0, r0 = on_wall(aa, t, n, L / 2 - VW, z(Z_EAVE), 0), on_wall(aa, t, n, L / 2 + VW, z(Z_EAVE), 0)
    B.face([l0, r0, ap], 'Panel', out=(n.x, n.y, 0))
    balustrade(B, V(on_wall(aa, t, n, 0, 0, 0)[:2]), V(on_wall(aa, t, n, L, 0, 0)[:2]), z(Z_EAVE), out=out, d=0.4)
    finial(B, ap[0], ap[1], ap[2] - 0.3, 1.0)
    for x in (L / 2 - VW, L / 2 + VW):
        c = on_wall(aa, t, n, x, 0, 0.6)
        pinnacle(B, c[0], c[1], z(Z_EAVE), 13.0, 1.4)


def chevet(B):
    """Apse (half 14-gon about APSE_U), ambulatory and the ring of radiating chapels with flyers."""
    n_ap = 7
    ap = [(APSE_U + VW * math.cos(math.radians(-90 + 180 * k / n_ap)), VW * math.sin(math.radians(-90 + 180 * k / n_ap)))
          for k in range(n_ap + 1)]
    for p, q in zip(ap, ap[1:]):
        p, q = V(p), V(q)
        nrm = (((p + q) / 2) - V((APSE_U, 0))).normalized()
        quad(B, (p.x, p.y), (q.x, q.y), z(Z_AISLE + 3.0), z(Z_EAVE), 'Stone', (nrm.x, nrm.y))
        a, b = ((p.x, p.y), (q.x, q.y))
        lancet(B, a, b, (q - p).length / 2, 2.6, z(28.5), 15.5, reveal=0.4)
        balustrade(B, p, q, z(Z_EAVE), out=(nrm.x, nrm.y))
        # apse roof facet up to the ridge end
        B.face([(p.x + nrm.x * 0.4, p.y + nrm.y * 0.4, z(Z_EAVE) - 0.6), (q.x + nrm.x * 0.4, q.y + nrm.y * 0.4, z(Z_EAVE) - 0.6),
                (APSE_U, 0, z(Z_RIDGE))], 'Lead', out=(nrm.x, nrm.y, 1))
    # chapel ring: outer wall polygon radius CHAP_R, with 7 chapel windows; lean roof to the clerestory
    n_r = 14
    ring = [(APSE_U + CHAP_R * math.cos(math.radians(-90 + 180 * k / n_r)), CHAP_R * math.sin(math.radians(-90 + 180 * k / n_r)))
            for k in range(n_r + 1)]
    for k, (p, q) in enumerate(zip(ring, ring[1:])):
        p, q = V(p), V(q)
        nrm = (((p + q) / 2) - V((APSE_U, 0))).normalized()
        quad(B, (p.x, p.y), (q.x, q.y), SINK, z(20.0), 'Stone', (nrm.x, nrm.y))
        lancet(B, (p.x, p.y), (q.x, q.y), (q - p).length / 2, 2.4, z(4.0), 13.0, reveal=0.4)
        balustrade(B, p, q, z(20.0), out=(nrm.x, nrm.y))
        # roof from the ring up to the apse clerestory
        pa = V((APSE_U, 0)) + (p - V((APSE_U, 0))).normalized() * VW
        qa = V((APSE_U, 0)) + (q - V((APSE_U, 0))).normalized() * VW
        B.face([(p.x, p.y, z(20.0)), (q.x, q.y, z(20.0)), (qa.x, qa.y, z(Z_AISLE + 3.2)), (pa.x, pa.y, z(Z_AISLE + 3.2))],
               'Lead', out=(nrm.x, nrm.y, 1))
    for k in range(n_r + 1):
        ang = math.radians(-90 + 180 * k / n_r)
        d = V((math.cos(ang), math.sin(ang)))
        c = V((APSE_U, 0))
        po = c + d * (CHAP_R + 1.4)
        pier(B, po.x, po.y, 2.0, 2.0, SINK, z(29.0), 10.0)
        pm = c + d * 15.5
        pier(B, pm.x, pm.y, 1.4, 1.4, z(Z_AISLE), z(36.0), 9.0)
        for zz in (z(28.0), z(24.0)):
            a0, a1 = c + d * (CHAP_R + 0.4), c + d * 16.4
            flyer(B, (a0.x, a0.y), zz, (a1.x, a1.y), zz + 4.0)
        for zz in (z(41.0), z(35.5)):
            a0, a1 = c + d * 14.6, c + d * VW
            flyer(B, (a0.x, a0.y), zz - 4.0, (a1.x, a1.y), zz)


def west_front(B):
    """The two towers (square stages, octagon, openwork spires) and the central bay between them."""
    for sgn in (1, -1):
        tc = (TC[0], sgn * TC[1])
        hw = (TV1 - TV0) / 2
        hd = (TU1 - TU0) / 2
        # square stages: S1, S2 full size; S3 inset
        for zz0, zz1, ins in ((SINK, z(Z_S1), 0.0), (z(Z_S1), z(Z_S2), 0.3), (z(Z_S2), z(Z_S3), 1.6)):
            poly = [(tc[0] - hd + ins, tc[1] - hw + ins), (tc[0] + hd - ins, tc[1] - hw + ins),
                    (tc[0] + hd - ins, tc[1] + hw - ins), (tc[0] - hd + ins, tc[1] + hw - ins)]
            prism(B, poly, zz0, zz1, 'Panel', top='Stone')
            P = ccw([V(p) for p in poly])
            for a, b, t, n in edges(P):
                facing_nave = (n.y * sgn < -0.5)
                facing_east = n.x > 0.5
                L = (b - a).length
                # the two lower stages have two window axes per face, split by a buttress with pinnacles
                outer_face = not facing_east and not facing_nave
                if zz1 != z(Z_S3) and outer_face:
                    c = a + t * (L / 2)
                    boxm(B, min(c.x, c.x + n.x * 1.8) - (0.8 if abs(n.x) < 0.5 else 0), max(c.x, c.x + n.x * 1.8) + (0.8 if abs(n.x) < 0.5 else 0),
                         min(c.y, c.y + n.y * 1.8) - (0.8 if abs(n.y) < 0.5 else 0), max(c.y, c.y + n.y * 1.8) + (0.8 if abs(n.y) < 0.5 else 0),
                         zz0, zz1 - 1.0, 'Panel', top='Stone')
                    pc = c + n * 0.9
                    pinnacle(B, pc.x, pc.y, zz1 - 1.0, 9.0, 1.3)
                if zz0 == SINK:
                    if n.x < -0.5:   # west: side portal under a big gable, two windows above
                        lancet(B, a, b, L / 2, 4.6, z(0.0), 11.0, mat='Door', reveal=1.4)
                        wimperg(B, a, b, L / 2, 6.6, z(10.0), 11.0, d=2.0)
                        for s in (L * 0.25, L * 0.75):
                            lancet(B, a, b, s, 3.6, z(14.0), 11.5)
                    elif outer_face:
                        for s in (L * 0.25, L * 0.75):
                            lancet(B, a, b, s, 3.8, z(5.0), 18.0)
                            wimperg(B, a, b, s, 4.6, z(21.5), 6.0, d=0.5)
                elif zz1 == z(Z_S2):
                    if outer_face:
                        for s in (L * 0.25, L * 0.75):
                            lancet(B, a, b, s, 4.2, z(30.5), 20.0)
                            wimperg(B, a, b, s, 5.2, z(48.5), 8.0, d=0.5)
                    elif facing_nave:
                        lancet(B, a, b, L / 2, 5.0, z(Z_EAVE + 1.5), 6.5, mat='Belfry')
                else:
                    lancet(B, a, b, L / 2, 5.4, z(62.0), 26.0, mat='Belfry')
                    wimperg(B, a, b, L / 2, 6.8, z(85.0), 10.0, d=0.5)
                balustrade(B, a, b, zz1, out=(n.x, n.y), d=0.2)
            # corner buttresses: stepped back with height, a pinnacle at each step
            for cu in (tc[0] - hd + ins, tc[0] + hd - ins):
                for cv in (tc[1] - hw + ins, tc[1] + hw - ins):
                    du = -1 if cu < tc[0] else 1
                    dv = -1 if cv < tc[1] else 1
                    depth = {0.0: 3.4, 0.3: 2.4, 1.6: 1.5}[ins]
                    # one buttress along u (front/back), one along v (sides)
                    boxm(B, cu - 1.3, cu + 1.3, cv + dv * 0.0, cv + dv * depth, zz0, zz1 - 1.0, 'Panel', top='Stone')
                    boxm(B, cu + du * 0.0, cu + du * depth, cv - 1.3, cv + 1.3, zz0, zz1 - 1.0, 'Panel', top='Stone')
                    pinnacle(B, cu + du * depth * 0.5, cv, zz1 - 1.0, 8.0 if ins < 1 else 12.0, 1.3)
                    pinnacle(B, cu, cv + dv * depth * 0.5, zz1 - 1.0, 8.0 if ins < 1 else 12.0, 1.3)
        # octagon with eight pinnacle turrets
        oc = poly_n(tc[0], tc[1], 7.2, 8)
        prism(B, oc, z(Z_S3), z(Z_OCT), 'Panel', top='Stone')
        P = ccw([V(p) for p in oc])
        for a, b, t, n in edges(P):
            lancet(B, a, b, (b - a).length / 2, 2.6, z(Z_S3 + 2.0), 10.0, mat='Belfry', reveal=0.5)
            wimperg(B, a, b, (b - a).length / 2, 3.6, z(Z_OCT - 1.5), 5.5, d=0.4)
            balustrade(B, a, b, z(Z_OCT), out=(n.x, n.y), d=0.1)
        for p in poly_n(tc[0], tc[1], 9.0, 8, 0):
            pinnacle(B, p[0], p[1], z(Z_S3), 18.0, 1.6)
        # openwork spire: eight faces with tracery holes, crockets along the ribs, the Kreuzblume on top
        base = poly_n(tc[0], tc[1], 6.4, 8)
        apex = (tc[0], tc[1], z(Z_SPIRE))
        pyramid(B, base, z(Z_OCT), apex, 'Openwork')
        for p in base:
            for k in range(1, 15):
                f = k / 15
                x = p[0] + (tc[0] - p[0]) * f
                y = p[1] + (tc[1] - p[1]) * f
                zz = z(Z_OCT) + (z(Z_SPIRE) - z(Z_OCT)) * f
                d = V((x - tc[0], y - tc[1]))
                d = d.normalized() * 0.55 if d.length > 1e-6 else V((0, 0))
                pyramid(B, poly_n(x + d.x, y + d.y, 0.32, 4, 45), zz, (x + d.x * 2.2, y + d.y * 2.2, zz + 0.9), 'Stone')
            # rib
            B.face([(p[0], p[1], z(Z_OCT)), (tc[0], tc[1], z(Z_SPIRE)), (tc[0], tc[1], z(Z_SPIRE) - 0.5),
                    (p[0], p[1], z(Z_OCT) - 0.5)], 'Stone')
        finial(B, tc[0], tc[1], z(Z_SPIRE) - 0.4, 2.6)
        boxm(B, tc[0] - 0.4, tc[0] + 0.4, tc[1] - 0.4, tc[1] + 0.4, z(Z_SPIRE) - 1.0, z(Z_TOP) - 1.2, 'Stone')
    # central bay between the towers: wall, main portal, great window, gable
    a, b = (TU0, TV0), (TU0, -TV0)
    quad(B, a, b, SINK, z(Z_EAVE + 1.5), 'Panel', (-1, 0))
    L = 2 * TV0
    lancet(B, a, b, L / 2, 6.4, z(0.0), 15.0, mat='Door', reveal=2.0)
    wimperg(B, a, b, L / 2, 8.0, z(14.0), 15.0, d=0.8)
    lancet(B, a, b, L / 2, 9.0, z(30.0), 16.0)
    aa, t, n = wall_frame(a, b)
    ap = on_wall(aa, t, n, L / 2, z(71.0), 0)
    B.face([on_wall(aa, t, n, 0, z(Z_EAVE + 1.5), 0), on_wall(aa, t, n, L, z(Z_EAVE + 1.5), 0), ap], 'Panel', out=(-1, 0, 0))
    finial(B, ap[0], ap[1], ap[2] - 0.3, 1.2)
    balustrade(B, V(a), V(b), z(Z_EAVE + 1.5), out=(-1, 0), d=0.4)
    gable_roof(B, TU0, TU1, TV0, z(Z_EAVE), z(Z_RIDGE), end0=False, end1=False)


def crossing_spire(B):
    """Dachreiter over the crossing: octagonal metal lantern and spire, gilded star, 109 m above the floor."""
    lan = poly_n(0, 0, 2.6, 8)
    prism(B, lan, z(Z_RIDGE - 2.0), z(76.0), 'Metal', top='Metal')
    P = ccw([V(p) for p in lan])
    for a, b, t, n in edges(P):
        lancet(B, a, b, (b - a).length / 2, 1.0, z(66.0), 8.0, mat='Belfry', frame='Metal', reveal=0.2)
    for p in poly_n(0, 0, 3.2, 8, 0):
        pyramid(B, poly_n(p[0], p[1], 0.3, 4, 45), z(74.0), (p[0], p[1], z(82.0)), 'Metal')
    pyramid(B, poly_n(0, 0, 2.8, 8), z(76.0), (0, 0, z(104.5)), 'Metal')
    boxm(B, -0.12, 0.12, -0.12, 0.12, z(104.0), z(108.0), 'Gold')
    for k in range(4):
        ang = math.radians(45 * k)
        dx, dy = math.cos(ang) * 1.0, math.sin(ang) * 1.0
        B.face([(-dx, -dy, z(107.6)), (dx, dy, z(107.6)), (dx, dy, z(107.8)), (-dx, -dy, z(107.8))], 'Gold')
    for sgn in (1, -1):  # star points
        B.face([(0, 0, z(108.0)), (0.5 * sgn, 0, z(108.6)), (0, 0, z(109.2)), (-0.5 * sgn, 0, z(108.6))], 'Gold')


def domtreppe(B):
    """The Domtreppe down to the Bahnhofsvorplatz (DGM1): 29 steps, u -31..21, top edge v 63 at F, bottom v 77."""
    u0, u1 = -31.0, 21.0
    v_top, v_bot = 63.0, 77.0
    n = 29
    z_bot = 1.1
    rise = (F - z_bot) / n
    tread = (v_bot - v_top) / n
    for k in range(n):
        vv = v_top + (k + 1) * tread       # nosing of step k (counted from the top)
        top = F - (k + 1) * rise + rise    # its tread height
        boxm(B, u0, u1, v_top - 0.5 if k == 0 else v_top + k * tread, vv, SINK, top, 'Steps')
    # cheek walls
    for u, out in ((u0 - 1.2, -1), (u1, 1)):
        prism(B, [(u, v_top - 2.0), (u + 1.2, v_top - 2.0), (u + 1.2, v_bot), (u, v_bot)], SINK, F + 0.6, 'Stone', top='Stone')


def build(B):
    # aisles and clerestory: nave (towers to the transept) and choir (transept to the apse), both sides
    for sgn in (1, -1):
        side_bays(B, [TU1] + NAVE_PIERS[::-1] + [-TRU], sgn)
        side_bays(B, [TRU] + CHOIR_PIERS, sgn)
    central_vessel(B)
    for sgn in (1, -1):
        transept_front(B, sgn)
    chevet(B)
    west_front(B)
    crossing_spire(B)
    domtreppe(B)


def build_collision(C):
    x = 'x'
    boxm(C, TU1, APSE_U, -VO, VO, SINK, z(Z_AISLE), x)
    boxm(C, -TRU, TRU, -TRV, TRV, SINK, z(Z_EAVE), x)
    boxm(C, TU0, APSE_U, -VW, VW, SINK, z(Z_EAVE), x)
    prism(C, [(APSE_U + CHAP_R * math.cos(math.radians(-90 + 180 * k / 14)), CHAP_R * math.sin(math.radians(-90 + 180 * k / 14)))
              for k in range(15)], SINK, z(20.0), x)
    for sgn in (1, -1):
        boxm(C, TU0 - 3.4, TU1, sgn * TV0 if sgn > 0 else -TV1 - 3.4, sgn * TV1 + 3.4 if sgn > 0 else -TV0, SINK, z(Z_S2), x)
        prism(C, poly_n(TC[0], sgn * TC[1], 9.0, 8), z(Z_S2), z(Z_OCT), x)
        pyramid(C, poly_n(TC[0], sgn * TC[1], 6.4, 8), z(Z_OCT), (TC[0], sgn * TC[1], z(Z_SPIRE)), x)
        for u in NAVE_PIERS + [TU1] + CHOIR_PIERS:
            boxm(C, u - 1.0, u + 1.0, sgn * VO if sgn > 0 else -VO - 3.2, sgn * VO + 3.2 if sgn > 0 else -VO, SINK, z(31.0), x)
        boxm(C, -TRU, TRU, sgn * TRV if sgn > 0 else -TRV - 3.6, sgn * TRV + 3.6 if sgn > 0 else -TRV, SINK, z(30.0), x)
    boxm(C, TU0 - 2.0, TU0, -TV0, TV0, SINK, z(20.0), x)
    # Domtreppe: a ramp through the nosings, cheek walls
    u0, u1, v_top, v_bot = -31.0, 21.0, 63.0, 77.0
    rise = (F - 1.1) / 29
    C.face([(u0, v_top - 0.5, F), (u1, v_top - 0.5, F), (u1, v_bot, 1.1 + rise), (u0, v_bot, 1.1 + rise)], x, out=(0, 0, 1))
    for u in (u0 - 1.2, u1):
        boxm(C, u, u + 1.2, v_top - 2.0, v_bot, SINK, F + 0.6, x)


def main():
    coll = reset_collection('KOELNER_DOM')
    B = Builder(make_materials(), tex_m=TEX_M)
    build(B)
    dom = B.to_object(NAME, coll, ORIGIN, 0.0)
    C = Builder()
    build_collision(C)
    col = C.to_object(f'{NAME}_col', coll, ORIGIN, 0.0)
    col.display_type = 'WIRE'
    col.hide_render = True
    return dom, col


dom, col = main()
stats = {'tris': tris(dom), 'col_tris': tris(col)}
print('KOELNER_DOM', stats)
if globals().get('EXPORT', True):
    export_glb(os.path.join(HERE, f'{NAME}.glb'), [dom, col])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'), copy=True)
