"""Neusser Str. / Florastraße (Köln-Nippes): the four buildings round the little square at U Florastraße.

Replaces DENW37AL1000AJzb, …AKKj, …BVEZ and …AKt2:
  AJzb  white Gründerzeit corner house: sandstone shop floor and first floor, two rendered floors with
        stucco window heads, a corner oriel with a slate cap, slate mansard with dormers, red tiled roof.
  AKKj  grey 1960s/70s tower with stacked white balconies and a beige brick strip; open ground floor,
        white slatted band above it (the "bridge" over the passage).
  BVEZ  dark green block over a wide open, columned ground floor (the passage under the pharmacy sign
        through to Florastraße behind); a small shop block along AKt2, beige brick strip next to AKKj.
  AKt2  15-storey tower clad in gold-beige corrugated metal, olive window panels, ground floor arcade with
        stone pillars and shop fronts.
Footprints and heights from LOD2, the rest from street photos.

Run inside Blender:  exec(open(PATH).read(), {'__file__': PATH})
World coordinates: Blender X = game x, Blender Y = −game z (north); see nnmodel.py / README.md.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from graffiti import GLYPHS  # noqa: E402
from nnmodel import (V, Builder, _blur_noise, _img, brick_texture, ccw, export_glb, line_x, material,  # noqa: E402
                     prism, reset_collection, slate_texture, tris, wall_frame)

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'neusser-florastrasse'
SINK = -0.3
RNG = np.random.default_rng(299)

# ---------------------------------------------------------------- footprints (Blender XY, CCW)

# AJzb, white corner house. Edges: 0 square face, 1 short kink, 2 party wall (AKKj), 3/4 back, 5 north party
# wall, 6 Neusser Str.
ALT = [(111.91, 240.11), (124.27, 226.17), (125.75, 225.01), (132.05, 233.41), (125.21, 241.54),
       (125.23, 244.08), (111.95, 244.22)]
ALT_ROOF = [  # LOD2 roof planes (eaves ~20.8 at the footprint, ridge 26.8)
    [(118.55, 240.83, 26.8), (125.21, 241.54, 20.9), (125.23, 244.08, 20.9), (118.58, 244.15, 26.8)],
    [(118.58, 244.15, 26.8), (111.95, 244.22, 20.9), (111.91, 240.12, 20.9), (118.55, 240.83, 26.8)],
    [(128.9, 229.22, 26.8), (132.05, 233.41, 21.1), (125.21, 241.54, 20.7), (118.55, 240.83, 26.8)],
    [(118.55, 240.83, 26.8), (111.91, 240.12, 20.7), (124.27, 226.17, 20.6), (125.75, 225.01, 21.0),
     (128.9, 229.22, 26.8)],
]
ALT_RIDGE_END_N = (118.58, 244.15)
ALT_RIDGE_END_E = (128.9, 229.22)
ALT_INSET = [1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]  # mansard depth per edge (0 = fire wall)
Z_ALT = [0.0, 4.6, 8.4, 12.2, 16.0]  # floor levels; cornice 16.0–16.6, mansard to 20.8
Z_MANS0, Z_MANS1, Z_RIDGE = 16.6, 20.8, 26.8

# AKKj, balcony tower (27.7 m) and its low back wing (7.5 m). Tower edges: 0 SE, 1 NE, 2 party (AJzb),
# 3 square face (open ground floor), 4 SW above BVEZ.
TOWER = [(138.39, 215.15), (146.8, 225.7), (133.52, 235.37), (125.75, 225.01), (131.86, 220.25)]
WING = [(133.52, 235.37), (146.8, 225.7), (153.23, 234.08), (139.94, 243.93)]
H_TOWER, H_WING = 27.7, 7.5
Z_T0, FLOOR_T = 3.4, 2.7  # ground floor height, storey height (9 upper floors)

# BVEZ, dark green block. Edges: 0 party (AKt2), 1 short, 2 SE face (back), 3 along AKKj (passage),
# 4 square face (arcade), 5 bend, 6 Neusser Str. tip.
GREEN = [(122.4, 203.95), (130.72, 204.51), (132.79, 202.93), (140.55, 213.47), (131.86, 220.25),
         (123.3, 210.15), (122.08, 208.56)]
H_GREEN, Z_G0 = 19.4, 3.6
STRIP_W, CORE_BACK = 4.0, 3.5  # brick strip on the square face; shop block depth along the back

# AKt2, corrugated tower (44.2 m) and its stair core annex. Edges: 0 S, 1 E, 2 N, 3 W (Neusser Str.)
TALL = [(116.89, 185.64), (131.69, 186.74), (130.72, 204.51), (115.71, 203.5)]
CORE = [(131.39, 192.25), (131.69, 186.74), (135.99, 187.02), (135.64, 192.46)]
H_TALL, Z_A0, H_CORE = 44.2, 4.4, 42.6
FLOOR_A = (H_TALL - Z_A0) / 14
TALL_ARCADE = 2.6


# ---------------------------------------------------------------- textures

def render_texture(name, base, seed, size=512, stain=0.08, grain=0.012):
    rng = np.random.default_rng(seed)
    img = np.ones((size, size, 3), np.float32) * np.array(base, np.float32)
    img *= (1 + 0.05 * _blur_noise(rng, size, 8))[..., None]
    img *= (1 + 0.03 * _blur_noise(rng, size, 32))[..., None]
    streak = _blur_noise(rng, size, 24)[:1, :].repeat(size, 0)
    img *= (1 - stain * np.clip(streak, 0, 1))[..., None]
    img += rng.normal(0, grain, img.shape)
    return _img(name, img)


def corrugated_texture(name, size=512, ribs=8):
    """Gold-beige profiled metal sheet: bright rib crowns, shaded flanks, faint vertical streaks."""
    rng = np.random.default_rng(5)
    x = np.arange(size) / size * ribs
    f = x - np.floor(x)
    prof = np.where(f < 0.5, 0.97, 0.80) + 0.1 * np.cos(2 * np.pi * f)
    prof[(f > 0.47) & (f < 0.53)] *= 0.82
    prof[(f > 0.97) | (f < 0.03)] *= 0.86
    img = np.ones((size, size, 3), np.float32) * np.array((0.90, 0.85, 0.67), np.float32)
    img *= prof[None, :, None]
    img *= (1 - 0.06 * np.clip(_blur_noise(rng, size, 20)[:1, :].repeat(size, 0), 0, 1))[..., None]
    img *= (1 + 0.03 * _blur_noise(rng, size, 6))[..., None]
    img += rng.normal(0, 0.008, img.shape)
    return _img(name, img)


def slats_texture(name, size=512, period=30):
    """White vertical slats with dark gaps (the band over the passage)."""
    rng = np.random.default_rng(6)
    x = np.arange(size) % period
    img = np.ones((size, size, 3), np.float32) * 0.9
    img[:, x < 9] = (0.16, 0.17, 0.18)
    img[:, (x >= 9) & (x < 12)] = 0.7
    img += rng.normal(0, 0.01, img.shape)
    return _img(name, img)


def window_texture(name, kind, lit=False, w=128, h=256):
    """Window with frame, mullions and curtains. kind 'old' (T-cross, transom), 'modern' (two casements),
    'door' (balcony door, lower panel). lit → the emission image (warm glass, black frames)."""
    rng = np.random.default_rng(len(name))
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w], np.float32)[:, None, None]
    glass = np.ones((h, w, 3), np.float32) * np.array((0.07, 0.09, 0.11), np.float32)
    glass += (0.16 * yy)[..., None] * np.array((0.8, 0.9, 1.0), np.float32)
    sheen = np.clip(1 - np.abs((xx + yy * 0.6) - 0.75) * 7, 0, 1) * 0.12
    glass += sheen[..., None]
    curtain = (xx < 0.24) | (xx > 0.76)
    if kind == 'modern':
        curtain = yy > 0.72  # half-drawn blinds
    cur_col = np.array((0.70, 0.67, 0.60), np.float32)
    img = np.where(curtain[..., None], cur_col * (0.9 + 0.1 * np.cos(xx * 90))[..., None], glass)
    if lit:
        img = 0.6 * np.where(curtain[..., None], np.array((1.0, 0.80, 0.52), np.float32),  # client: ×0.12 by day, ×1.5 at night
                             np.array((0.92, 0.62, 0.30), np.float32) * (0.7 + 0.3 * yy)[..., None])
    fw = 0.06
    frame = (xx < fw) | (xx > 1 - fw) | (yy < fw * 0.5) | (yy > 1 - fw * 0.5)
    if kind == 'old':
        frame |= (np.abs(xx - 0.5) < 0.03) | (np.abs(yy - 0.72) < 0.02)
    elif kind == 'modern':
        frame |= np.abs(xx - 0.62) < 0.03
    elif kind == 'door':
        frame |= (np.abs(yy - 0.38) < 0.02)
        img[yy < 0.38] = (0.0, 0.0, 0.0) if lit else (0.85, 0.85, 0.83)
    img[frame] = (0.0, 0.0, 0.0) if lit else (0.92, 0.92, 0.90)
    if not lit:
        img += rng.normal(0, 0.006, img.shape)
    return _img(name, img)


def shopfront_texture(name, lit=False, w=256, h=256):
    """Shop window: dark glass, hints of shelves and goods behind, aluminium mullions."""
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w], np.float32)[:, None, None]
    img = np.ones((h, w, 3), np.float32) * np.array((0.10, 0.11, 0.12), np.float32)
    goods = rng.uniform(0.2, 0.7, (8, 16, 3)).astype(np.float32)
    gi = goods[(yy * 8).astype(int).clip(0, 7), (xx * 16).astype(int).clip(0, 15)]
    shelf = ((yy * 8) % 1 < 0.75) & (yy > 0.15) & (yy < 0.8)
    img = np.where(shelf[..., None], img + gi * 0.18, img)
    img += (0.12 * np.clip(1 - np.abs(xx + yy - 1.1) * 5, 0, 1))[..., None]
    if lit:
        img = 0.4 * np.where(shelf[..., None], 0.55 + gi * 0.6, np.full((h, w, 3), 0.75, np.float32)) * \
            np.array((1.0, 0.9, 0.75), np.float32)
    mull = (np.abs(xx - 0.5) < 0.012) | (xx < 0.02) | (xx > 0.98) | (yy < 0.03) | (yy > 0.97)
    img[mull] = 0.0 if lit else 0.6
    return _img(name, img)


def text_image(name, text, w=512, h=96, fg=(1, 1, 1), bg=(0.12, 0.13, 0.13), cross=None, stroke=0.11):
    """Sign: `text` in the stroke font from graffiti.py, optional green cross on the left."""
    img = np.ones((h, w, 3), np.float32) * np.array(bg, np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    x0 = h * 1.1 if cross else h * 0.3
    gh = h * 0.56
    gw = gh * 0.72
    step = (w - x0 - h * 0.2) / len(text)
    gw = min(gw, step * 0.8)
    mask = np.zeros((h, w), bool)
    for i, ch in enumerate(text):
        ox = x0 + i * step + (step - gw) / 2
        oy = (h - gh) / 2
        for line in GLYPHS.get(ch, []):
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                pa = np.array((ox + ax * gw, oy + (1 - ay) * gh))
                pb = np.array((ox + bx * gw, oy + (1 - by) * gh))
                d = pb - pa
                t = np.clip(((xx - pa[0]) * d[0] + (yy - pa[1]) * d[1]) / max(d @ d, 1e-6), 0, 1)
                dist = np.hypot(xx - pa[0] - t * d[0], yy - pa[1] - t * d[1])
                mask |= dist < gh * stroke * 0.5
    img[mask] = fg
    if cross:
        c, s, a = h * 0.55, h * 0.12, h * 0.36
        m = ((np.abs(xx - c) < s) & (np.abs(yy - h / 2) < a)) | ((np.abs(yy - h / 2) < s) & (np.abs(xx - c) < a))
        img[m] = cross
    return _img(name, img[::-1].copy())  # row 0 at the bottom


def make_materials():
    old = window_texture('tex_win_old', 'old')
    old_lit = window_texture('tex_win_old_lit', 'old', lit=True)
    mod = window_texture('tex_win_mod', 'modern')
    mod_lit = window_texture('tex_win_mod_lit', 'modern', lit=True)
    door = window_texture('tex_win_door', 'door')
    door_lit = window_texture('tex_win_door_lit', 'door', lit=True)
    shop = shopfront_texture('tex_shop')
    shop_lit = shopfront_texture('tex_shop_lit', lit=True)
    sign = text_image('tex_sign_apotheke', 'APOTHEKE', cross=(0.1, 0.75, 0.3))
    return {
        # white corner house
        'RenderWhite': material('RenderWhite', image=render_texture('tex_render_white', (0.90, 0.89, 0.85), 31), rough=0.9),
        'Stucco': material('Stucco', (0.94, 0.93, 0.89), 0.8),
        'Sandstone': material('Sandstone', image=brick_texture('tex_sandstone', [(0.82, 0.75, 0.62), (0.80, 0.73, 0.60),
                                                                               (0.84, 0.77, 0.64)], (0.78, 0.72, 0.61),
                                                              32, nx=4, ny=6), rough=0.9),
        'Slate': material('Slate', image=slate_texture('tex_slate', 33), rough=0.6),
        'RoofTile': material('RoofTile', image=brick_texture('tex_tiles', [(0.66, 0.26, 0.16), (0.60, 0.22, 0.14),
                                                                          (0.70, 0.30, 0.19)], (0.40, 0.16, 0.10),
                                                             34, nx=12, ny=20), rough=0.75),
        'Zinc': material('Zinc', (0.50, 0.52, 0.54), 0.45, 0.6),
        'Chimney': material('Chimney', image=brick_texture('tex_chimney', [(0.55, 0.24, 0.17), (0.48, 0.20, 0.15)],
                                                           (0.6, 0.58, 0.55), 35), rough=0.9),
        'Awning': material('Awning', (0.0, 0.52, 0.47), 0.85),
        'DoorWood': material('DoorWood', (0.40, 0.24, 0.14), 0.6),
        'GlassDark': material('GlassDark', (0.08, 0.10, 0.12), 0.15),
        # windows (Lit variants glow at night)
        'WinOld': material('WinOld', image=old, rough=0.2),
        'WinOldLit': material('WinOldLit', image=old, emit_image=old_lit, rough=0.2),
        'WinMod': material('WinMod', image=mod, rough=0.2),
        'WinModLit': material('WinModLit', image=mod, emit_image=mod_lit, rough=0.2),
        'WinDoor': material('WinDoor', image=door, rough=0.2),
        'WinDoorLit': material('WinDoorLit', image=door, emit_image=door_lit, rough=0.2),
        'Shop': material('Shop', image=shop, emit_image=shop_lit, rough=0.15),
        # balcony tower
        'RenderGrey': material('RenderGrey', image=render_texture('tex_render_grey', (0.70, 0.70, 0.68), 36, stain=0.14), rough=0.9),
        'BrickBeige': material('BrickBeige', image=brick_texture('tex_brick_beige', [(0.66, 0.62, 0.55), (0.60, 0.57, 0.51),
                                                                                    (0.70, 0.66, 0.58)], (0.55, 0.53, 0.50), 37),
                               rough=0.9),
        'Slats': material('Slats', image=slats_texture('tex_slats'), rough=0.6),
        'BalconyWhite': material('BalconyWhite', (0.90, 0.90, 0.88), 0.7),
        'Concrete': material('Concrete', image=render_texture('tex_concrete', (0.58, 0.58, 0.56), 38, stain=0.15), rough=0.9),
        # green block
        'DarkGreen': material('DarkGreen', image=render_texture('tex_dark_green', (0.19, 0.24, 0.20), 39, stain=0.1, grain=0.006),
                              rough=0.9),
        'Sign': material('Sign', image=sign, emit_image=sign, rough=0.5),
        'SignBand': material('SignBand', (0.30, 0.31, 0.31), 0.6),
        # corrugated tower
        'Corrugated': material('Corrugated', image=corrugated_texture('tex_corrugated'), rough=0.45, metal=0.3),
        'Olive': material('Olive', (0.47, 0.45, 0.30), 0.6, 0.2),
        'TrimDark': material('TrimDark', (0.22, 0.22, 0.21), 0.6, 0.3),
        'Pillar': material('Pillar', image=render_texture('tex_pillar', (0.84, 0.80, 0.71), 40, stain=0.05), rough=0.8),
        'Soffit': material('Soffit', (0.78, 0.75, 0.66), 0.85),
        'ShopWall': material('ShopWall', (0.60, 0.57, 0.52), 0.8),
        'RoofDark': material('RoofDark', (0.25, 0.25, 0.25), 0.95),
        'Coping': material('Coping', (0.78, 0.78, 0.76), 0.7, 0.3),
    }


# ---------------------------------------------------------------- geometry helpers

class Wall:
    """Frame on a footprint edge a→b (CCW polygon): u along the wall, d outwards, z up."""

    def __init__(self, a, b):
        self.a, self.t, self.n = wall_frame(a, b)
        self.L = (V(b) - V(a)).to_2d().length

    def p(self, u, d=0.0, z=None):
        q = self.a + self.t * u + self.n * d
        return (q.x, q.y) if z is None else (q.x, q.y, z)

    def out(self, up=0.0):
        return (self.n.x, self.n.y, up)


def walls(poly):
    return [Wall(a, b) for a, b in zip(poly, poly[1:] + poly[:1])]


def panel(B, w, u0, u1, z0, z1, mat, d=0.02, uvs=None):
    B.face([w.p(u0, d, z0), w.p(u1, d, z0), w.p(u1, d, z1), w.p(u0, d, z1)], mat, out=w.out(), uvs=uvs)


def obox(B, w, u0, u1, d0, d1, z0, z1, mat, top=None, bottom=False):
    prism(B, [w.p(u0, d0), w.p(u1, d0), w.p(u1, d1), w.p(u0, d1)], z0, z1, mat, top=top or mat, bottom=bottom)


UV01 = [(0, 0), (1, 0), (1, 1), (0, 1)]


def lit_mat(base, p=0.33):
    return base + 'Lit' if RNG.random() < p else base


def window(B, w, u, z0, width, height, mat='WinMod', d=0.02, sill=None, frame=None):
    """Window centred at u, sill z0. `frame`: material of a raised surround (gives the opening depth)."""
    panel(B, w, u - width / 2, u + width / 2, z0, z0 + height, lit_mat(mat), d, UV01)
    if frame:
        f = 0.12
        obox(B, w, u - width / 2 - f, u - width / 2, -0.05, 0.08, z0, z0 + height, frame)
        obox(B, w, u + width / 2, u + width / 2 + f, -0.05, 0.08, z0, z0 + height, frame)
        obox(B, w, u - width / 2 - f, u + width / 2 + f, -0.05, 0.08, z0 + height, z0 + height + f, frame)
    if sill:
        obox(B, w, u - width / 2 - 0.08, u + width / 2 + 0.08, -0.05, 0.12, z0 - 0.08, z0, sill)


def offset(poly, ds):
    """Polygon with each edge i (poly[i]→poly[i+1]) moved inwards by ds[i]."""
    n = len(poly)
    lines = []
    for i in range(n):
        a, b = V(poly[i]).to_2d(), V(poly[(i + 1) % n]).to_2d()
        t = (b - a).normalized()
        lines.append((a + V((-t.y, t.x)) * ds[i], t, ds[i]))
    out = []
    for i in range(n):
        p, dp, d0 = lines[i - 1]
        q, dq, d1 = lines[i]
        c = V(poly[i]).to_2d()
        if abs(dp.x * dq.y - dp.y * dq.x) < 0.05:  # (almost) collinear edges
            out.append(c + V((-dp.y, dp.x)) * d0)
            if abs(d0 - d1) > 1e-6:
                out.append(c + V((-dq.y, dq.x)) * d1)
        else:
            out.append(line_x(p, dp, q, dq))
    return [(p.x, p.y) for p in out]


def pyramid(B, base, z0, apex, mat):
    c = V((sum(p[0] for p in base) / len(base), sum(p[1] for p in base) / len(base), apex))
    for a, b in zip(base, base[1:] + base[:1]):
        mid = (V((a[0], a[1], z0)) + V((b[0], b[1], z0))) / 2
        B.face([(a[0], a[1], z0), (b[0], b[1], z0), c], mat, out=tuple(mid - V((c.x, c.y, z0))))


def soffit(B, poly, z, mat='Soffit'):
    B.face([(p[0], p[1], z) for p in poly], mat, out=(0, 0, -1))


# ---------------------------------------------------------------- AJzb: white corner house

def arched_window(B, w, u, z0, width, h_rect, mat='WinOld', frame='Sandstone', seg=8):
    """Round-headed window: rectangular lower part plus a semicircular dark head and a stone archivolt."""
    r = width / 2
    window(B, w, u, z0, width, h_rect, mat, sill='Sandstone')
    zc = z0 + h_rect
    pts = [w.p(u + r * math.cos(math.pi * k / seg), 0.02, zc + r * math.sin(math.pi * k / seg)) for k in range(seg + 1)]
    B.face(pts, 'GlassDark', out=w.out())
    for k in range(seg):
        a0, a1 = math.pi * k / seg, math.pi * (k + 1) / seg
        r0, r1 = r, r + 0.16
        B.face([w.p(u + r0 * math.cos(a0), 0.08, zc + r0 * math.sin(a0)), w.p(u + r1 * math.cos(a0), 0.08, zc + r1 * math.sin(a0)),
                w.p(u + r1 * math.cos(a1), 0.08, zc + r1 * math.sin(a1)), w.p(u + r0 * math.cos(a1), 0.08, zc + r0 * math.sin(a1))],
               frame, out=w.out())
    for x in (u - r - 0.16, u + r):
        obox(B, w, x, x + 0.16, -0.05, 0.08, z0, zc, frame)


def shop_arch(B, w, u, width, z_top=3.7, spring=2.9, seg=8):
    """Shop window under a segmental arch in the sandstone ground floor."""
    hw = width / 2
    panel(B, w, u - hw, u + hw, 0.35, spring, 'Shop', 0.02, UV01)
    rise = z_top - spring
    pts = [w.p(u + hw * math.cos(math.pi * k / seg), 0.02, spring + rise * math.sin(math.pi * k / seg)) for k in range(seg + 1)]
    B.face(pts, 'GlassDark', out=w.out())
    for x in (u - hw - 0.25, u + hw):  # piers
        obox(B, w, x, x + 0.25, -0.05, 0.1, 0.0, spring, 'Sandstone')
    obox(B, w, u - hw - 0.3, u + hw + 0.3, -0.05, 0.12, z_top, z_top + 0.3, 'Sandstone')  # keystone band


def awning(B, w, u0, u1, z, depth, drop=0.75, mat='Awning'):
    """Sloping shop awning with a short front valance and side cheeks."""
    a0, a1 = w.p(u0, 0.1, z), w.p(u1, 0.1, z)
    b0, b1 = w.p(u0, depth, z - drop), w.p(u1, depth, z - drop)
    B.face([a0, a1, b1, b0], mat, out=w.out(1.5))
    B.face([a0, a1, b1, b0], mat, out=tuple(-x for x in w.out(1.5)))
    c0, c1 = w.p(u0, depth, z - drop - 0.28), w.p(u1, depth, z - drop - 0.28)
    B.face([b0, b1, c1, c0], mat, out=w.out())
    B.face([b0, b1, c1, c0], mat, out=tuple(-x for x in w.out()))
    for (aa, bb) in ((a0, b0), (a1, b1)):
        B.face([aa, bb, (bb[0], bb[1], bb[2] - 0.28)], mat, out=(w.t.x, w.t.y, 0))
        B.face([aa, bb, (bb[0], bb[1], bb[2] - 0.28)], mat, out=(-w.t.x, -w.t.y, 0))


def alt_upper_window(B, w, u, z_floor):
    """Rendered floors: tall window with stucco surround, sill and a projecting cornice head."""
    window(B, w, u, z_floor + 0.9, 1.25, 2.05, 'WinOld', frame='Stucco', sill='Stucco')
    obox(B, w, u - 0.95, u + 0.95, -0.05, 0.2, z_floor + 3.07, z_floor + 3.27, 'Stucco')


def dormer(B, w, u, width=1.3):
    zf = 17.1
    obox(B, w, u - width / 2, u + width / 2, -1.0, -0.3, zf, 19.6, 'RenderWhite')
    window(B, w, u, 17.95, 0.85, 1.35, 'WinOld', d=-0.28)
    obox(B, w, u - width / 2 - 0.1, u + width / 2 + 0.1, -1.1, -0.18, 19.6, 19.82, 'Zinc')


def build_alt(B):
    W = walls(ALT)
    sq, kink, _, back1, back2, north, street = W
    prism(B, ALT, SINK, Z_MANS0, 'RenderWhite')
    exposed = (sq, kink, street)
    for w in exposed:  # sandstone shop floor and first floor, belt course, main cornice
        panel(B, w, 0, w.L, SINK, Z_ALT[2], 'Sandstone', 0.005)
        obox(B, w, -0.05, w.L + 0.05, -0.05, 0.14, Z_ALT[2] - 0.05, Z_ALT[2] + 0.22, 'Sandstone')
        obox(B, w, -0.1, w.L + 0.1, -0.05, 0.25, Z_ALT[1] - 0.1, Z_ALT[1] + 0.12, 'Sandstone')
        obox(B, w, -0.15, w.L + 0.15, -0.05, 0.3, Z_ALT[4] - 0.2, Z_ALT[4] + 0.15, 'Stucco')
        obox(B, w, -0.25, w.L + 0.25, -0.05, 0.48, Z_ALT[4] + 0.15, Z_MANS0, 'Stucco')
    for w in (back1, back2):
        obox(B, w, -0.1, w.L + 0.1, -0.05, 0.3, Z_MANS0 - 0.3, Z_MANS0, 'Stucco')

    # --- square face: shops, arched first floor, two rendered floors, corner oriel near the AKKj end
    axes = [1.4, 3.7, 6.0, 8.3, 10.6, 12.9]
    for u in (2.55, 7.15, 11.75):
        shop_arch(B, sq, u, 3.3)
    for u in (2.55, 7.15):
        awning(B, sq, u - 1.9, u + 1.9, 3.75, 1.7)
    # entrance in the oriel axis: wooden double door under a round arch
    panel(B, sq, 15.25, 16.55, 0.0, 2.9, 'DoorWood', 0.03)
    arched = [(15.9 + 0.65 * math.cos(math.pi * k / 8), 2.9 + 0.65 * math.sin(math.pi * k / 8)) for k in range(9)]
    B.face([sq.p(u, 0.03, z) for u, z in arched], 'GlassDark', out=sq.out())
    for u in axes:
        arched_window(B, sq, u, Z_ALT[1] + 0.75, 1.15, 1.95)
        for zf in Z_ALT[2:4]:
            alt_upper_window(B, sq, u, zf)
    oriel(B, sq, 14.3, 17.5)
    for u in axes[::2] + [axes[-1]]:
        dormer(B, sq, u)

    # --- Neusser Str. face (narrow): one window axis, shop door below
    panel(B, street, 0.6, 3.4, 0.35, 3.3, 'Shop', 0.02, UV01)
    arched_window(B, street, 2.0, Z_ALT[1] + 0.75, 1.15, 1.95)
    for zf in Z_ALT[2:4]:
        alt_upper_window(B, street, 2.0, zf)
    dormer(B, street, 2.0)

    # --- back (courtyard) faces: plain windows
    for u in (1.6, 4.0, 6.4, 8.8):
        for zf in Z_ALT[1:4]:
            window(B, back1, u, zf + 0.9, 1.1, 1.8, 'WinMod', sill='Stucco')
        window(B, back1, u, 0.9, 1.1, 1.6, 'WinMod')

    mansard_and_roof(B)


def oriel(B, w, u0, u1, depth=0.9):
    """Three-sided bay from the first floor to above the cornice, slate cap with a finial."""
    ch = 0.6
    base = [w.p(u0, 0), w.p(u1, 0), w.p(u1 - ch, depth), w.p(u0 + ch, depth)]
    z0, z1 = Z_ALT[1] + 0.2, 19.4
    prism(B, base, z0, z1, 'RenderWhite', bottom=True)
    obox(B, w, u0 - 0.1, u1 + 0.1, -0.05, depth + 0.12, z0 - 0.35, z0, 'Sandstone')  # corbel slab
    front = Wall(w.p(u0 + ch, depth), w.p(u1 - ch, depth))  # u along the wall direction
    left = Wall(w.p(u0, 0), w.p(u0 + ch, depth))
    right = Wall(w.p(u1 - ch, depth), w.p(u1, 0))
    for zf in Z_ALT[1:4]:
        window(B, front, front.L / 2, zf + 0.85, 1.2, 2.0, 'WinOld', frame='Stucco', sill='Stucco')
        for s in (left, right):
            window(B, s, s.L / 2, zf + 0.85, 0.42, 2.0, 'WinOld', sill='Stucco')
    window(B, front, front.L / 2, 17.4, 1.0, 1.5, 'WinOld', frame='Stucco')
    # cornice ring and slate helm
    ring = [w.p(u0 - 0.2, 0), w.p(u1 + 0.2, 0), w.p(u1 - ch + 0.05, depth + 0.2), w.p(u0 + ch - 0.05, depth + 0.2)]
    prism(B, ring, z1, z1 + 0.25, 'Stucco', bottom=True)
    pyramid(B, ring, z1 + 0.25, z1 + 3.2, 'Slate')
    tip = V(w.p((u0 + u1) / 2, depth * 0.45))
    prism(B, [(tip.x - 0.05, tip.y - 0.05), (tip.x + 0.05, tip.y - 0.05), (tip.x + 0.05, tip.y + 0.05), (tip.x - 0.05, tip.y + 0.05)],
          z1 + 2.5, z1 + 4.0, 'Zinc')


def mansard_and_roof(B):
    inset = offset(ALT, ALT_INSET)
    n = len(ALT)
    for i in range(n):
        a, b = ALT[i], ALT[(i + 1) % n]
        a2, b2 = inset[i], inset[(i + 1) % n]
        w = Wall(a, b)
        if ALT_INSET[i] > 0:  # slate mansard
            B.face([(a[0], a[1], Z_MANS0), (b[0], b[1], Z_MANS0), (b2[0], b2[1], Z_MANS1), (a2[0], a2[1], Z_MANS1)],
                   'Slate', out=w.out(0.25))
            B.face([(a2[0], a2[1], Z_MANS1 - 0.05), (b2[0], b2[1], Z_MANS1 - 0.05), (b2[0], b2[1], Z_MANS1 + 0.15),
                    (a2[0], a2[1], Z_MANS1 + 0.15)], 'Zinc', out=w.out())
        else:  # fire wall up to the mansard top
            B.face([(a[0], a[1], Z_MANS0), (b[0], b[1], Z_MANS0), (b2[0], b2[1], Z_MANS1), (a2[0], a2[1], Z_MANS1)],
                   'RenderWhite', out=w.out())
    # upper roof: LOD2 planes with their eaves pulled in to the mansard top
    def eave(p):
        k = min(range(n), key=lambda i: (V(ALT[i]) - V(p[:2])).length)
        return (inset[k][0], inset[k][1], Z_MANS1 + 0.1)
    for poly in ALT_ROOF:
        pts = [p if p[2] > 22 else eave(p) for p in poly]
        B.face(pts, 'RoofTile', out=(0, 0, 1))
    # gables on the two fire walls
    for i, ridge in ((5, ALT_RIDGE_END_N), (2, ALT_RIDGE_END_E)):
        a2, b2 = inset[i], inset[(i + 1) % n]
        B.face([(a2[0], a2[1], Z_MANS1 + 0.1), (b2[0], b2[1], Z_MANS1 + 0.1), (ridge[0], ridge[1], Z_RIDGE)], 'RenderWhite',
               out=Wall(ALT[i], ALT[(i + 1) % n]).out())
    # ridge capping and chimneys
    for a, b in (((118.58, 244.15), (118.55, 240.83)), ((118.55, 240.83), (128.9, 229.22))):
        w = Wall(a, b)
        obox(B, w, 0, w.L, -0.12, 0.12, Z_RIDGE - 0.05, Z_RIDGE + 0.12, 'Zinc')
    for c, h in (((121.0, 236.0), 27.8), ((116.0, 242.6), 27.3), ((127.6, 233.0), 27.6)):
        prism(B, [(c[0] - 0.4, c[1] - 0.3), (c[0] + 0.4, c[1] - 0.3), (c[0] + 0.4, c[1] + 0.3), (c[0] - 0.4, c[1] + 0.3)],
              23.0, h, 'Chimney', top='Concrete')


# ---------------------------------------------------------------- AKKj: balcony tower

def balcony(B, w, u0, u1, z, depth=1.3):
    obox(B, w, u0, u1, 0.0, depth, z - 0.18, z, 'Concrete', bottom=True)
    obox(B, w, u0, u1, depth - 0.08, depth, z, z + 1.05, 'BalconyWhite')
    obox(B, w, u0, u0 + 0.08, 0.0, depth - 0.08, z, z + 1.05, 'BalconyWhite')
    obox(B, w, u1 - 0.08, u1, 0.0, depth - 0.08, z, z + 1.05, 'BalconyWhite')


def build_tower(B):
    W = walls(TOWER)
    se, ne, _, sq, sw = W
    core = offset(TOWER, [0, 0, 0, 2.5, 0])
    prism(B, core, SINK, Z_T0, 'ShopWall')
    prism(B, TOWER, Z_T0, H_TOWER, 'RenderGrey', top='RoofDark', bottom=True)
    for w in W:
        obox(B, w, -0.05, w.L + 0.05, -0.05, 0.12, H_TOWER - 0.35, H_TOWER + 0.15, 'Coping')
    prism(B, WING, SINK, H_WING, 'RenderGrey', top='RoofDark')
    for w in walls(WING):
        obox(B, w, -0.05, w.L + 0.05, -0.05, 0.1, H_WING - 0.25, H_WING + 0.1, 'Coping')

    floors = [Z_T0 + k * FLOOR_T for k in range(9)]
    # --- square face (sq: from AJzb to the passage corner, 7.7 m): open ground floor, white slats, balconies
    panel(B, sq, -0.3, sq.L, Z_T0 - 0.3, Z_T0 + 2.6, 'Slats', 0.15)
    obox(B, sq, -0.3, sq.L, -0.2, 0.15, Z_T0 - 0.35, Z_T0, 'Concrete', bottom=True)
    soffit(B, [sq.p(0, 0), sq.p(sq.L, 0), sq.p(sq.L, -2.5), sq.p(0, -2.5)], Z_T0 - 0.35)
    shop_front_strip(B, sq, 0.4, sq.L - 0.2, -2.48, door_at=2.0)
    panel(B, sq, 4.0, sq.L, Z_T0 + 2.6, H_TOWER - 0.35, 'BrickBeige', 0.03)
    for zf in floors[1:]:
        balcony(B, sq, 0.2, 3.8, zf)
        window(B, sq, 1.2, zf + 0.05, 0.9, 2.15, 'WinDoor')
        window(B, sq, 2.75, zf + 0.9, 1.3, 1.3, 'WinMod')
        window(B, sq, 5.9, zf + 0.9, 1.3, 1.35, 'WinMod', sill='Concrete')
    # --- SW face above the green block
    for zf in floors[6:]:
        balcony(B, sw, 1.5, 5.1, zf)
        window(B, sw, 2.5, zf + 0.05, 0.9, 2.15, 'WinDoor')
        window(B, sw, 4.0, zf + 0.9, 1.3, 1.3, 'WinMod')
        window(B, sw, 6.9, zf + 0.9, 1.3, 1.35, 'WinMod', sill='Concrete')
    # --- SE and NE faces: window grid, balconies on the NE (courtyard) side
    for zf in floors[1:]:
        for u in (2.0, 5.6, 9.2, 12.0):
            window(B, se, u, zf + 0.9, 1.3, 1.35, 'WinMod', sill='Concrete')
    for zf in floors:
        if zf + 0.9 < H_WING:
            continue
        for u in (2.2, 8.5, 14.0):
            window(B, ne, u, zf + 0.9, 1.3, 1.35, 'WinMod', sill='Concrete')
        if zf > H_WING:
            balcony(B, ne, 4.0, 7.2, zf)
            window(B, ne, 5.6, zf + 0.05, 0.9, 2.15, 'WinDoor')
    for w in walls(WING):
        for u in np.arange(2.0, w.L - 1.0, 3.2):
            window(B, w, u, 4.3, 1.2, 1.35, 'WinMod')


def shop_front_strip(B, w, u0, u1, d, door_at=None, z1=3.0):
    """Glazed shop front along a recessed ground-floor wall (d < 0)."""
    k = max(1, round((u1 - u0) / 2.2))
    step = (u1 - u0) / k
    for i in range(k):
        a, b = u0 + i * step + 0.06, u0 + (i + 1) * step - 0.06
        if door_at is not None and a <= door_at <= b:
            panel(B, w, a, b, 0.0, z1, 'GlassDark', d + 0.02)
        else:
            panel(B, w, a, b, 0.3, z1, 'Shop', d + 0.02, UV01)


# ---------------------------------------------------------------- BVEZ: dark green block over the arcade

def green_core():
    """Ground-floor shop block of BVEZ: only a strip along the tower; the rest is an open, columned hall
    (the wide passage under the pharmacy sign through to Florastraße behind)."""
    a, b, c, d = (V(p) for p in GREEN[:4])
    t = (d - c).normalized()
    x = c + t * CORE_BACK
    return [GREEN[6], GREEN[0], GREEN[1], GREEN[2], (x.x, x.y)]


GREEN_COLS = [(4.5, -0.4), (9.0, -0.4), (4.5, -6.0), (9.0, -6.0), (2.0, -9.5)]  # (u, d) on the square face


def build_green(B):
    W = walls(GREEN)
    _, short, back, along, sq, bend, tip = W
    core = green_core()
    prism(B, core, SINK, Z_G0, 'ShopWall')
    prism(B, GREEN, Z_G0, H_GREEN, 'DarkGreen', top='RoofDark')
    soffit(B, GREEN, Z_G0)
    for w in W:
        obox(B, w, -0.05, w.L + 0.05, -0.05, 0.1, H_GREEN - 0.3, H_GREEN + 0.1, 'Coping')
    floors = [Z_G0 + 0.8 + k * 3.0 for k in range(5)]

    # --- square face: beige brick strip with the slatted band next to AKKj, then the sign band
    sw = STRIP_W
    panel(B, sq, 0.0, sw, Z_G0, Z_G0 + 2.6, 'Slats', 0.15)
    obox(B, sq, 0.0, sw, -0.2, 0.15, Z_G0 - 0.25, Z_G0, 'Concrete', bottom=True)
    panel(B, sq, 0.0, sw, Z_G0 + 2.6, H_GREEN - 0.3, 'BrickBeige', 0.03)
    for zf in floors[1:]:
        window(B, sq, sw / 2, zf + 0.9, 1.25, 1.35, 'WinMod', sill='Concrete')
    panel(B, sq, sw, sq.L + 0.05, Z_G0, Z_G0 + 0.8, 'SignBand', 0.06)
    panel(B, sq, sw + 0.6, sw + 6.0, Z_G0 + 0.08, Z_G0 + 0.72, 'Sign', 0.09, UV01)
    for zf in floors:
        for c in (sw + 2.1, sw + 6.6):
            for du in (-0.7, 0.7):
                window(B, sq, c + du, zf + 0.85, 1.2, 1.4, 'WinMod', sill='Coping')
    for u, d in GREEN_COLS:
        obox(B, sq, u - 0.3, u + 0.3, d - 0.3, d + 0.3, 0.0, Z_G0, 'Concrete')
    # the bend and the street tip (shop window on the tip)
    for zf in floors:
        window(B, tip, tip.L / 2, zf + 0.85, 1.4, 1.4, 'WinMod', sill='Coping')
    panel(B, tip, 0.0, tip.L, Z_G0, Z_G0 + 0.8, 'SignBand', 0.06)
    shop_front_strip(B, tip, 0.3, tip.L - 0.3, 0.0, door_at=tip.L - 1.0)
    # --- back face towards Florastraße
    for zf in floors:
        for u in (2.0, 5.4, 8.8, 11.2):
            window(B, back, u, zf + 0.85, 1.3, 1.4, 'WinMod', sill='Coping')
    panel(B, back, 0.4, CORE_BACK - 0.4, 0.3, 3.0, 'Shop', 0.02, UV01)
    # the core's wall facing the hall: shop windows and a door
    hall = Wall(core[4], core[0])
    shop_front_strip(B, hall, 0.6, hall.L - 0.6, 0.0, door_at=hall.L * 0.6)


# ---------------------------------------------------------------- AKt2: corrugated tower

def build_tall(B):
    W = walls(TALL)
    south, east, north, west = W
    core = offset(TALL, [0, 0, TALL_ARCADE, TALL_ARCADE])
    prism(B, core, SINK, Z_A0, 'ShopWall')
    prism(B, TALL, Z_A0, H_TALL, 'Corrugated', top='RoofDark', bottom=False)
    soffit(B, TALL, Z_A0)
    for w in W:
        obox(B, w, -0.05, w.L + 0.05, -0.05, 0.1, Z_A0 - 0.05, Z_A0 + 0.35, 'Soffit')  # edge of the cantilever
        obox(B, w, -0.08, w.L + 0.08, -0.08, 0.12, H_TALL - 0.55, H_TALL + 0.1, 'TrimDark')
    prism(B, CORE, SINK, H_CORE, 'Corrugated', top='RoofDark')
    for w in walls(CORE):
        obox(B, w, -0.05, w.L + 0.05, -0.05, 0.1, H_CORE - 0.4, H_CORE + 0.1, 'TrimDark')
    # roof: lift motor room
    c = V((124.5, 196.0))
    prism(B, [(c.x - 2.2, c.y - 1.6), (c.x + 2.2, c.y - 1.6), (c.x + 2.2, c.y + 1.6), (c.x - 2.2, c.y + 1.6)], H_TALL, H_TALL + 2.4,
          'Corrugated', top='RoofDark')

    floors = [Z_A0 + k * FLOOR_A for k in range(14)]

    def column(w, u, ks, wid=2.3):
        for k in ks:
            zf = floors[k]
            panel(B, w, u - wid / 2 - 0.1, u + wid / 2 + 0.1, zf + 0.12, zf + FLOOR_A - 0.12, 'Olive', 0.03)
            window(B, w, u, zf + 0.95, wid, 1.45, 'WinMod', d=0.05, sill='TrimDark')

    for u in (2.7, 6.9, 11.1, 15.3):  # west (street) face: u from the north corner
        column(west, u, range(1, 14))
        panel(B, west, u - 0.12, u + 0.12, floors[0] + 0.6, floors[0] + 2.2, 'TrimDark', 0.04)
    column(north, north.L - 2.4, range(1, 14))
    column(north, north.L - 6.6, [k for k in range(14) if floors[k] > H_GREEN])
    column(south, 2.6, [k for k in range(14) if floors[k] > 24.0])
    for u in (3.0, 7.4, 11.8):
        column(east, u, range(1, 14))

    # --- ground floor: stone pillars under the cantilever, shop fronts behind
    for u in (0.55, 4.8, 9.0, 13.2, west.L - 0.55):
        obox(B, west, u - 0.4, u + 0.4, -0.95, -0.15, 0.0, Z_A0, 'Pillar')
    obox(B, north, north.L - 6.7, north.L - 5.9, -0.95, -0.15, 0.0, Z_A0, 'Pillar')
    cw = walls(core)
    for w in (cw[3], cw[2]):  # recessed west and north walls
        shop_front_strip(B, w, 0.3, w.L - 0.3, 0.0, door_at=w.L / 2, z1=3.4)
        panel(B, w, 0.0, w.L, 3.5, Z_A0, 'Coping', 0.03)


# ---------------------------------------------------------------- collision

def build_collision(C):
    prism(C, ALT, SINK, Z_MANS1, 'x', top='x')
    prism(C, offset(TOWER, [0, 0, 0, 2.5, 0]), SINK, Z_T0, 'x', top='x')
    prism(C, TOWER, Z_T0, H_TOWER, 'x', top='x', bottom=True)
    prism(C, WING, SINK, H_WING, 'x', top='x')
    prism(C, green_core(), SINK, Z_G0, 'x', top='x')
    prism(C, GREEN, Z_G0, H_GREEN, 'x', top='x', bottom=True)
    sq = walls(GREEN)[4]
    for u, d in GREEN_COLS:
        obox(C, sq, u - 0.3, u + 0.3, d - 0.3, d + 0.3, SINK, Z_G0, 'x')
    prism(C, offset(TALL, [0, 0, TALL_ARCADE, TALL_ARCADE]), SINK, Z_A0, 'x', top='x')
    prism(C, TALL, Z_A0, H_TALL, 'x', top='x', bottom=True)
    prism(C, CORE, SINK, H_CORE, 'x', top='x')
    west, north = walls(TALL)[3], walls(TALL)[2]
    for u in (0.55, 4.8, 9.0, 13.2, west.L - 0.55):
        obox(C, west, u - 0.4, u + 0.4, -0.95, -0.15, SINK, Z_A0, 'x')
    obox(C, north, north.L - 6.7, north.L - 5.9, -0.95, -0.15, SINK, Z_A0, 'x')


def main():
    for poly in (ALT, TOWER, WING, GREEN, TALL, CORE):
        assert ccw(list(poly)) == list(poly), poly
    coll = reset_collection('NEUSSER_FLORASTRASSE')
    B = Builder(make_materials())
    build_alt(B)
    build_tower(B)
    build_green(B)
    build_tall(B)
    ob = B.to_object(NAME, coll)
    C = Builder()
    build_collision(C)
    col = C.to_object(f'{NAME}_col', coll)
    col.display_type = 'WIRE'
    col.hide_render = True
    return ob, col


ob, col = main()
stats = {'tris': tris(ob), 'col_tris': tris(col)}
print('STATS', stats)
if globals().get('EXPORT', True):
    export_glb(os.path.join(HERE, f'{NAME}.glb'), [ob, col])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'), copy=True)
