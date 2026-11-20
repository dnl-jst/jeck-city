"""Erft-Haus, Neusser Str. 27–29 (Köln-Neustadt-Nord, Agnesviertel): Jugendstil front house with the passage.

Replaces DENW37AL1000eZaq (No. 27) and DENW37AL1000eVXe (No. 29), which together are one front house of
22.4 × 11 m between the fire walls of No. 25 and No. 33. Street face (south → north, as seen from the street):
  rusticated sandstone strip · cream field with one window axis · bay (Erker) over three storeys under a small
  slate roof, above it a stone shoulder of the gable with one arched window ·
  white centre field framed by sandstone that rises into a curved gable above the eaves · three-sided oriel
  with a slate helm and dark blue edge lines · narrow white field · sandstone strip.
Ground floor: shop fronts, and under the "ERFT-HAUS / NEUSSER-STRASSE 27-29" lettering the passage
(Durchgang) through the house into the courtyard behind (open, walkable and drivable).
Footprint and heights from LOD2, facade from a street photo.

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
from nnmodel import (V, Builder, _blur_noise, _img, brick_texture, ccw, export_glb, grid_window_texture, material, prism,  # noqa: E402
                     reset_collection, slate_texture, tris, wall_frame)

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'erft-haus'
SINK = -0.3
RNG = np.random.default_rng(2729)

# ---------------------------------------------------------------- footprint (Blender XY, CCW)

SW, SE, NE, NW = (290.65, -1218.42), (301.64, -1219.40), (303.64, -1197.08), (292.66, -1196.04)
FOOT = [SW, SE, NE, NW]  # edges: 0 south fire wall (No. 25), 1 street face, 2 north fire wall (No. 33), 3 back
Z_GF, Z_BAND = 3.9, 4.8  # shop/passage top, top of the lettering band
FLOORS = [4.8, 8.1, 11.4, 14.7]  # the four upper storeys
Z_EAVE, Z_RIDGE = 17.9, 22.7
P0, P1 = 9.0, 12.1  # passage on the street face (u from the south end)
Z_PASS = Z_GF


def lerp(a, b, f):
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)


L_ST = (V(NE) - V(SE)).length


def E(u):
    """Point on the street face, u metres from the south end."""
    return lerp(SE, NE, u / L_ST)


def W(u):
    """Point on the back face opposite street position u."""
    return lerp(SW, NW, u / L_ST)


def R(u):
    """Ridge point (middle of the depth) opposite street position u."""
    return lerp(W(u), E(u), 0.5)


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


def window_texture(name, kind, lit=False, w=128, h=256):
    """Window with frame, mullions and curtains. kind 'old' (T-cross, transom) or 'tall' (two casements,
    transom, net curtains). lit → the emission image (warm glass, black frames)."""
    rng = np.random.default_rng(len(name))
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w], np.float32)[:, None, None]
    glass = np.ones((h, w, 3), np.float32) * np.array((0.07, 0.09, 0.11), np.float32)
    glass += (0.16 * yy)[..., None] * np.array((0.8, 0.9, 1.0), np.float32)
    sheen = np.clip(1 - np.abs((xx + yy * 0.6) - 0.75) * 7, 0, 1) * 0.12
    glass += sheen[..., None]
    curtain = (xx < 0.2) | (xx > 0.8)
    if kind == 'tall':
        curtain = (yy < 0.7) & ((np.cos(xx * 120) > -0.2) | (xx < 0.15) | (xx > 0.85))  # net curtains
    cur_col = np.array((0.78, 0.76, 0.68), np.float32)
    img = np.where(curtain[..., None], cur_col * (0.9 + 0.1 * np.cos(xx * 90))[..., None], glass)
    if lit:
        img = 0.6 * np.where(curtain[..., None], np.array((1.0, 0.80, 0.52), np.float32),
                             np.array((0.92, 0.62, 0.30), np.float32) * (0.7 + 0.3 * yy)[..., None])
    fw = 0.06
    frame = (xx < fw) | (xx > 1 - fw) | (yy < fw * 0.5) | (yy > 1 - fw * 0.5)
    frame |= (np.abs(xx - 0.5) < 0.03) & (yy < 0.72) | (np.abs(yy - 0.72) < 0.02)
    img[frame] = (0.0, 0.0, 0.0) if lit else (0.93, 0.93, 0.91)
    if not lit:
        img += rng.normal(0, 0.006, img.shape)
    return _img(name, img)


def shopfront_texture(name, lit=False, w=256, h=256, seed=11, tint=(1.0, 0.9, 0.75)):
    """Shop window: dark glass, hints of shelves and goods behind."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w], np.float32)[:, None, None]
    img = np.ones((h, w, 3), np.float32) * np.array((0.10, 0.11, 0.12), np.float32)
    goods = rng.uniform(0.2, 0.7, (8, 16, 3)).astype(np.float32)
    gi = goods[(yy * 8).astype(int).clip(0, 7), (xx * 16).astype(int).clip(0, 15)]
    shelf = ((yy * 8) % 1 < 0.75) & (yy > 0.1) & (yy < 0.75)
    img = np.where(shelf[..., None], img + gi * 0.2, img)
    img += (0.12 * np.clip(1 - np.abs(xx + yy - 1.1) * 5, 0, 1))[..., None]
    if lit:
        img = 0.4 * np.where(shelf[..., None], 0.55 + gi * 0.6, np.full((h, w, 3), 0.75, np.float32)) * \
            np.array(tint, np.float32)
    return _img(name, img)


def flower_texture(name, lit=False, w=256, h=256):
    """Flower shop window: dark glass with bunches and pot plants in the lower half."""
    rng = np.random.default_rng(23)
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w], np.float32)[:, None, None]
    img = np.ones((h, w, 3), np.float32) * np.array((0.09, 0.10, 0.10), np.float32)
    for _ in range(40):  # leaves first
        cx, cy, r = rng.uniform(0, 1), rng.uniform(0.0, 0.55), rng.uniform(0.03, 0.07)
        m = (xx - cx) ** 2 + ((yy - cy) * 1.6) ** 2 < r * r
        img[m] = np.array((0.16, 0.30, 0.13), np.float32) * rng.uniform(0.6, 1.2)
    for _ in range(260):
        cx, cy, r = rng.uniform(0, 1), rng.uniform(0.05, 0.6), rng.uniform(0.008, 0.022)
        col = np.array([(0.85, 0.3, 0.4), (0.95, 0.8, 0.3), (0.9, 0.9, 0.85), (0.3, 0.55, 0.25), (0.8, 0.45, 0.2),
                        (0.6, 0.35, 0.7)][rng.integers(0, 6)], np.float32)
        m = (xx - cx) ** 2 + ((yy - cy) * 1.2) ** 2 < r * r
        img[m] = col * rng.uniform(0.6, 1.0)
    img += (0.10 * np.clip(1 - np.abs(xx + yy - 1.1) * 5, 0, 1))[..., None]
    if lit:
        img = img * 2.2 + 0.25 * np.array((1.0, 0.85, 0.65), np.float32)
        img *= 0.45
    return _img(name, img)


GLYPHS2 = dict(GLYPHS)
GLYPHS2.update({
    '-': [[(0.15, 0.48), (0.85, 0.48)]],
    ' ': [],
    '2': [[(0, 0.8), (0.25, 1), (0.75, 1), (1, 0.8), (1, 0.6), (0, 0), (1, 0)]],
    '9': [[(1, 0.6), (0.7, 0.45), (0.3, 0.45), (0, 0.65), (0, 0.85), (0.25, 1), (0.75, 1), (1, 0.85), (1, 0.25),
           (0.7, 0), (0.15, 0)]],
})


def text_image(name, text, w, h, fg, bg, stroke=0.17):
    """Lettering in the stroke font (graffiti.py), glyph cells evenly spread over the width."""
    img = np.ones((h, w, 3), np.float32) * np.array(bg, np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    gh = h * 0.62
    step = (w - h * 0.2) / len(text)
    gw = min(gh * 0.72, step * 0.78)
    mask = np.zeros((h, w), bool)
    for i, ch in enumerate(text):
        ox = h * 0.1 + i * step + (step - gw) / 2
        oy = (h - gh) / 2
        for line in GLYPHS2.get(ch, []):
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                pa = np.array((ox + ax * gw, oy + (1 - ay) * gh))
                pb = np.array((ox + bx * gw, oy + (1 - by) * gh))
                d = pb - pa
                t = np.clip(((xx - pa[0]) * d[0] + (yy - pa[1]) * d[1]) / max(d @ d, 1e-6), 0, 1)
                dist = np.hypot(xx - pa[0] - t * d[0], yy - pa[1] - t * d[1])
                mask |= dist < gh * stroke * 0.5
    img[mask] = fg
    return _img(name, img[::-1].copy())  # row 0 at the bottom


def glow_image(name, col):
    return _img(name, np.ones((8, 8, 3), np.float32) * np.array(col, np.float32))


def make_materials():
    old = window_texture('tex_erft_win', 'old')
    old_lit = window_texture('tex_erft_win_lit', 'old', lit=True)
    tall = window_texture('tex_erft_win_tall', 'tall')
    tall_lit = window_texture('tex_erft_win_tall_lit', 'tall', lit=True)
    shop = shopfront_texture('tex_erft_shop')
    shop_lit = shopfront_texture('tex_erft_shop_lit', lit=True)
    shop2 = shopfront_texture('tex_erft_shop2', seed=12)
    shop2_lit = shopfront_texture('tex_erft_shop2_lit', lit=True, seed=12, tint=(0.85, 0.9, 1.0))
    flowers = flower_texture('tex_erft_flowers')
    flowers_lit = flower_texture('tex_erft_flowers_lit', lit=True)
    band_bg, gold = (0.80, 0.73, 0.60), (0.55, 0.40, 0.12)
    sign1 = text_image('tex_erft_sign1', 'ERFT-HAUS', 512, 64, gold, band_bg)
    sign2 = text_image('tex_erft_sign2', 'NEUSSER-STRASSE 27-29', 1024, 80, gold, band_bg)
    hof = grid_window_texture('tex_erft_win_hof', cols=2, rows=3, arch=0.10, curtains=True, seed=1)
    hof_lit = grid_window_texture('tex_erft_win_hof_lit', cols=2, rows=3, arch=0.10, curtains=True, seed=1, lit=True)
    return {
        # the courtyard face: yellow brick and arched casement windows, as the wings (../erft-haus-hof)
        'Klinker': material('ErftKlinker', image=brick_texture('tex_erft_klinker', [(0.80, 0.64, 0.38), (0.74, 0.58, 0.34), (0.84, 0.70, 0.44),
                                                                                   (0.68, 0.52, 0.31), (0.78, 0.60, 0.40)],
                                                               (0.62, 0.57, 0.48), 71, soot=0.10), rough=0.9),
        'WinHof': material('WinHof', image=hof, rough=0.2, clip=True),
        'WinHofLit': material('WinHofLit', image=hof, emit_image=hof_lit, rough=0.2, clip=True),
        'Render': material('Render', image=render_texture('tex_erft_render', (0.94, 0.91, 0.81), 41, stain=0.06), rough=0.9),
        'RenderBack': material('RenderBack', image=render_texture('tex_erft_render_back', (0.78, 0.76, 0.71), 42, stain=0.14),
                               rough=0.9),
        'Stucco': material('Stucco', (0.96, 0.93, 0.85), 0.8),
        'Sandstone': material('Sandstone', image=brick_texture('tex_erft_rustica', [(0.63, 0.53, 0.40), (0.58, 0.49, 0.37),
                                                                                   (0.67, 0.57, 0.44), (0.60, 0.52, 0.41)],
                                                              (0.52, 0.45, 0.35), 43, nx=3, ny=6, soot=0.12), rough=0.95),
        'SandBand': material('SandBand', image=render_texture('tex_erft_band', band_bg, 44, stain=0.1), rough=0.85),
        'Blue': material('Blue', (0.09, 0.13, 0.33), 0.5),
        'Slate': material('Slate', image=slate_texture('tex_erft_slate', 45), rough=0.6),
        'Zinc': material('Zinc', (0.50, 0.52, 0.54), 0.45, 0.6),
        'Chimney': material('Chimney', image=brick_texture('tex_erft_chimney', [(0.55, 0.24, 0.17), (0.48, 0.20, 0.15)],
                                                           (0.6, 0.58, 0.55), 46), rough=0.9),
        'DoorRed': material('DoorRed', (0.66, 0.10, 0.10), 0.5),
        'DoorWood': material('DoorWood', (0.36, 0.22, 0.13), 0.6),
        'GlassDark': material('GlassDark', (0.08, 0.10, 0.12), 0.15),
        'TrimDark': material('TrimDark', (0.16, 0.17, 0.18), 0.55, 0.3),
        'WinOld': material('WinOld', image=old, rough=0.2),
        'WinOldLit': material('WinOldLit', image=old, emit_image=old_lit, rough=0.2),
        'WinTall': material('WinTall', image=tall, rough=0.2),
        'WinTallLit': material('WinTallLit', image=tall, emit_image=tall_lit, rough=0.2),
        'Shop': material('Shop', image=shop, emit_image=shop_lit, rough=0.15),
        'Shop2': material('Shop2', image=shop2, emit_image=shop2_lit, rough=0.15),
        'Flowers': material('Flowers', image=flowers, emit_image=flowers_lit, rough=0.15),
        'Sign1': material('Sign1', image=sign1, rough=0.6),
        'Sign2': material('Sign2', image=sign2, rough=0.6),
        'PassageWall': material('PassageWall', image=brick_texture('tex_erft_tiles', [(0.80, 0.78, 0.72), (0.77, 0.75, 0.70),
                                                                                     (0.82, 0.80, 0.74)], (0.62, 0.60, 0.56),
                                                                   47, nx=4, ny=8), rough=0.5),
        'Paving': material('Paving', image=brick_texture('tex_erft_paving', [(0.42, 0.41, 0.40), (0.47, 0.46, 0.44),
                                                                            (0.39, 0.38, 0.37)], (0.30, 0.30, 0.29),
                                                         48, nx=6, ny=12), rough=0.9),
        'Soffit': material('Soffit', (0.86, 0.85, 0.82), 0.85),
        'Lamp': material('Lamp', (1.0, 0.95, 0.85), 0.4, emit_image=glow_image('tex_erft_lamp', (1.0, 0.86, 0.62))),
        'Board': material('Board', (0.12, 0.13, 0.14), 0.4, 0.3),
        'RoofDark': material('RoofDark', (0.24, 0.24, 0.25), 0.9),
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

    def inv(self, up=0.0):
        return (-self.n.x, -self.n.y, up)


def panel(B, w, u0, u1, z0, z1, mat, d=0.02, uvs=None):
    B.face([w.p(u0, d, z0), w.p(u1, d, z0), w.p(u1, d, z1), w.p(u0, d, z1)], mat, out=w.out(), uvs=uvs)


def obox(B, w, u0, u1, d0, d1, z0, z1, mat, top=None, bottom=False):
    prism(B, [w.p(u0, d0), w.p(u1, d0), w.p(u1, d1), w.p(u0, d1)], z0, z1, mat, top=top or mat, bottom=bottom)


UV01 = [(0, 0), (1, 0), (1, 1), (0, 1)]


def lit_mat(base, p=0.3):
    return base + 'Lit' if RNG.random() < p else base


def window(B, w, u, z0, width, height, mat='WinTall', d=0.02, sill='Stucco', frame='Stucco', head=True):
    """Window centred at u, sill z0, with a raised stucco surround, sill and (head) a small cornice."""
    panel(B, w, u - width / 2, u + width / 2, z0, z0 + height, lit_mat(mat), d, UV01)
    if frame:
        f = 0.12
        obox(B, w, u - width / 2 - f, u - width / 2, -0.05, 0.08, z0, z0 + height, frame)
        obox(B, w, u + width / 2, u + width / 2 + f, -0.05, 0.08, z0, z0 + height, frame)
        obox(B, w, u - width / 2 - f, u + width / 2 + f, -0.05, 0.08, z0 + height, z0 + height + f, frame)
    if sill:
        obox(B, w, u - width / 2 - 0.1, u + width / 2 + 0.1, -0.05, 0.14, z0 - 0.09, z0, sill)
    if head and frame:
        obox(B, w, u - width / 2 - 0.22, u + width / 2 + 0.22, -0.05, 0.16, z0 + height + f, z0 + height + f + 0.12, frame)


def arch_pts(w, uc, zc, r, d, seg=10, a0=0.0, a1=math.pi):
    return [w.p(uc + r * math.cos(a0 + (a1 - a0) * k / seg), d, zc + r * math.sin(a0 + (a1 - a0) * k / seg))
            for k in range(seg + 1)]


def arched_window(B, w, u, z0, width, h_rect, mat='WinOld', frame='Stucco', seg=8):
    """Round-headed window: rectangular lower part, semicircular dark head and an archivolt."""
    r = width / 2
    window(B, w, u, z0, width, h_rect, mat, frame=None, sill=frame)
    zc = z0 + h_rect
    B.face(arch_pts(w, u, zc, r, 0.02, seg), 'GlassDark', out=w.out())
    for k in range(seg):
        a0, a1 = math.pi * k / seg, math.pi * (k + 1) / seg
        r0, r1 = r, r + 0.14
        B.face([w.p(u + r0 * math.cos(a0), 0.08, zc + r0 * math.sin(a0)), w.p(u + r1 * math.cos(a0), 0.08, zc + r1 * math.sin(a0)),
                w.p(u + r1 * math.cos(a1), 0.08, zc + r1 * math.sin(a1)), w.p(u + r0 * math.cos(a1), 0.08, zc + r0 * math.sin(a1))],
               frame, out=w.out())
    for x in (u - r - 0.14, u + r):
        obox(B, w, x, x + 0.14, -0.05, 0.08, z0, zc, frame)


def slab(B, w, pts_uz, d0, d1, mat, side_mat=None):
    """Extrusion of a convex (u, z) outline between depths d0 < d1 on wall frame w (front at d1)."""
    front = [w.p(u, d1, z) for u, z in pts_uz]
    back = [w.p(u, d0, z) for u, z in pts_uz]
    B.face(front, mat, out=w.out())
    B.face(back, mat, out=w.inv())
    n = len(pts_uz)
    for i in range(n):
        j = (i + 1) % n
        (ua, za), (ub, zb) = pts_uz[i], pts_uz[j]
        mid_u, mid_z = (ua + ub) / 2, (za + zb) / 2
        cu = sum(p[0] for p in pts_uz) / n
        cz = sum(p[1] for p in pts_uz) / n
        o = V(w.p(mid_u, 0, mid_z)) - V(w.p(cu, 0, cz))
        B.face([front[i], front[j], back[j], back[i]], side_mat or mat, out=tuple(o))


def blue_edge(B, w, u, z0, z1, d=0.0, width=0.11):
    obox(B, w, u - width / 2, u + width / 2, d - 0.02, d + 0.03, z0, z1, 'Blue')


# ---------------------------------------------------------------- the house

BAY = (3.8, 8.4, 0.45)  # u0, u1, depth of the bay (Erker)
ORIEL = (14.6, 19.6, 0.85, 0.6)  # u0, u1, depth, chamfer
CENTRE = (8.7, 14.4)  # white centre field
ARCH_C, ARCH_R, ARCH_SPRING = 11.55, 2.85, 16.4
GABLE = (5.6, 17.5, 22.0)  # sandstone gable above the eaves: u0, u1, apex


def body(B):
    """Masonry blocks left and right of the passage and the bridge over it."""
    pw = ['Render', 'Render', 'PassageWall', 'Klinker']  # south block: fire wall, street, passage side, back
    prism(B, [W(0), E(0), E(P0), W(P0)], SINK, Z_EAVE, 'Render', side_mats=pw)
    prism(B, [W(P1), E(P1), E(L_ST), W(L_ST)], SINK, Z_EAVE, 'Render',
          side_mats=['PassageWall', 'Render', 'Render', 'Klinker'])
    prism(B, [W(P0), E(P0), E(P1), W(P1)], Z_PASS, Z_EAVE, 'Render',
          side_mats=['Render', 'Render', 'Render', 'Klinker'], bottom=True)


def passage(B):
    q = [W(P0), E(P0), E(P1), W(P1)]
    # floor: flush with the sidewalk (0.12) at the street, down to the courtyard (0.0)
    B.face([(q[1][0], q[1][1], 0.12), (q[2][0], q[2][1], 0.12), (q[3][0], q[3][1], 0.0), (q[0][0], q[0][1], 0.0)],
           'Paving', out=(0, 0, 1))
    B.face([(p[0], p[1], Z_PASS - 0.001) for p in q], 'Soffit', out=(0, 0, -1))
    south = Wall(E(P0), W(P0))  # north face of the south block, u from the street inwards
    north = Wall(W(P1), E(P1))  # south face of the north block, u from the courtyard
    # plinth strips, house door with glass, letter boxes and a notice board
    for w in (south, north):
        panel(B, w, 0.0, w.L, 0.0, 0.9, 'Paving', 0.01)
    panel(B, south, 4.6, 6.0, 0.05, 2.5, 'DoorWood', 0.02)
    panel(B, south, 4.75, 5.85, 0.9, 2.3, 'GlassDark', 0.03)
    obox(B, south, 4.5, 6.1, -0.05, 0.08, 2.5, 2.62, 'Stucco')
    obox(B, north, north.L - 2.3, north.L - 1.3, -0.02, 0.12, 0.9, 1.9, 'Zinc')
    obox(B, north, north.L - 5.0, north.L - 3.6, -0.02, 0.06, 1.1, 2.1, 'Board')
    # the red lattice gate: its two leaves stand open against the passage walls, a red beam over the opening
    for w, a in ((south, 0.2), (north, north.L - 1.75)):
        b = a + 1.55
        for u in (a, b - 0.06):
            obox(B, w, u, u + 0.06, 0.05, 0.11, 0.1, 3.3, 'DoorRed')
        for z in (0.1, 1.7, 3.24):
            obox(B, w, a, b, 0.05, 0.11, z, z + 0.06, 'DoorRed')
        for k in range(1, 6):
            obox(B, w, a + 1.55 * k / 6 - 0.012, a + 1.55 * k / 6 + 0.012, 0.065, 0.095, 0.1, 3.3, 'DoorRed')
        for k in range(1, 12):
            if k != 6:
                obox(B, w, a, b, 0.065, 0.095, 0.1 + 3.2 * k / 12 - 0.012, 0.1 + 3.2 * k / 12 + 0.012, 'DoorRed')
    obox(B, Wall(SE, NE), P0, P1, 0.0, 0.1, Z_PASS - 0.22, Z_PASS, 'DoorRed')
    # two ceiling lamps
    for f in (0.3, 0.7):
        c = V(lerp(lerp(E(P0), E(P1), 0.5), lerp(W(P0), W(P1), 0.5), f))
        B.face([(c.x - 0.25, c.y - 0.25, Z_PASS - 0.04), (c.x + 0.25, c.y - 0.25, Z_PASS - 0.04),
                (c.x + 0.25, c.y + 0.25, Z_PASS - 0.04), (c.x - 0.25, c.y + 0.25, Z_PASS - 0.04)], 'Lamp', out=(0, 0, -1))
    # stone reveal around the opening on the street, plain one on the courtyard side
    st = Wall(SE, NE)
    for u0 in (P0 - 0.35, P1):
        obox(B, st, u0, u0 + 0.35, -0.02, 0.12, 0.0, Z_PASS, 'Sandstone')
    back = Wall(NW, SW)
    for u0 in (back.L - P1 - 0.3, back.L - P0):
        obox(B, back, u0, u0 + 0.3, -0.02, 0.06, 0.0, Z_PASS, 'Klinker')
    obox(B, back, back.L - P1 - 0.3, back.L - P0 + 0.3, -0.02, 0.06, Z_PASS, Z_PASS + 0.45, 'Klinker')


def ground_floor(B, st):
    # sandstone skin of the street face (everything not white below)
    panel(B, st, 0.0, P0, SINK, Z_EAVE, 'Sandstone', 0.01)
    panel(B, st, P1, st.L, SINK, Z_EAVE, 'Sandstone', 0.01)
    panel(B, st, P0, P1, Z_PASS, Z_EAVE, 'Sandstone', 0.01)
    # shop A: red door and dark-framed windows
    panel(B, st, 0.35, 1.25, 0.0, 2.7, 'DoorRed', 0.04)
    panel(B, st, 0.35, 1.25, 2.8, Z_GF - 0.2, 'GlassDark', 0.04)
    shop_front(B, st, 1.45, 8.3, 'Shop', door=7.3)
    # shops B (flowers) and C
    shop_front(B, st, 12.65, 17.35, 'Flowers', door=13.4)
    shop_front(B, st, 17.8, 21.6, 'Shop2', door=None)
    # lettering band with cornice
    panel(B, st, 0.0, st.L, Z_GF, Z_BAND, 'SandBand', 0.05)
    obox(B, st, -0.02, st.L + 0.02, -0.02, 0.22, Z_BAND - 0.12, Z_BAND, 'Stucco')
    panel(B, st, 10.0, 13.9, Z_GF + 0.47, Z_BAND - 0.16, 'Sign1', 0.06, UV01)
    panel(B, st, 9.55, 14.35, Z_GF + 0.06, Z_GF + 0.42, 'Sign2', 0.06, UV01)


def shop_front(B, st, u0, u1, mat, door=None):
    """Shop windows in a dark frame, mullions every ~1.6 m; `door`: u of a glass door (dark glass)."""
    obox(B, st, u0 - 0.08, u1 + 0.08, -0.05, 0.06, 0.0, Z_GF - 0.1, 'TrimDark')
    k = max(1, round((u1 - u0) / 1.6))
    step = (u1 - u0) / k
    for i in range(k):
        a, b = u0 + i * step + 0.05, u0 + (i + 1) * step - 0.05
        if door is not None and a <= door <= b:
            panel(B, st, a, b, 0.0, Z_GF - 0.2, 'GlassDark', 0.08)
        else:
            panel(B, st, a, b, 0.4, Z_GF - 0.2, mat, 0.08, UV01)
            panel(B, st, a, b, 0.0, 0.4, 'TrimDark', 0.08)


def left_part(B, st):
    # white field with one window axis
    panel(B, st, 1.1, BAY[0], Z_BAND, 16.9, 'Render', 0.03)
    for zf in FLOORS:
        window(B, st, 2.45, zf + 0.9, 1.15, 1.9, 'WinTall', d=0.05)
        obox(B, st, 1.7, 3.2, -0.02, 0.07, zf + 0.25, zf + 0.75, 'Stucco')  # stucco panel under the sill
    blue_edge(B, st, 1.1, Z_BAND, 16.9, 0.03, 0.08)

    # bay over three storeys: console, box, blue edges, three windows a floor, a small slate roof
    u0, u1, dp = BAY
    zc = FLOORS[3] + 0.15  # the bay's top
    obox(B, st, u0 - 0.25, u1 + 0.25, -0.02, dp + 0.25, Z_BAND - 0.55, Z_BAND, 'Stucco', bottom=True)
    obox(B, st, u0 - 0.25, u1 + 0.25, dp + 0.2, dp + 0.27, Z_BAND - 0.5, Z_BAND - 0.1, 'Stucco')
    obox(B, st, u0, u1, -0.02, dp, Z_BAND, zc, 'Render')
    for u in (u0, u1):
        blue_edge(B, st, u, Z_BAND, zc, dp)
    bay = Wall(st.p(u0, dp), st.p(u1, dp))
    c = bay.L / 2
    for k, zf in enumerate(FLOORS[:3]):
        for du in (-1.05, 0.0, 1.05):
            if k == 0:
                window(B, bay, c + du, zf + 0.9, 0.85, 1.9, 'WinTall', head=False)
            else:
                arched_window(B, bay, c + du, zf + 0.9, 0.8, 1.5 if k == 1 else 1.35, 'WinOld')
        obox(B, bay, 0.2, bay.L - 0.2, -0.02, 0.08, zf + 0.35, zf + 0.6, 'Stucco')  # stucco garland band
    obox(B, st, u0 - 0.1, u1 + 0.1, -0.05, dp + 0.18, zc - 0.3, zc, 'Stucco')
    zr = zc + 1.15
    f0, f1, b0, b1 = st.p(u0 - 0.1, dp + 0.18, zc), st.p(u1 + 0.1, dp + 0.18, zc), st.p(u0 + 0.5, 0.02, zr), st.p(u1 - 0.5, 0.02, zr)
    B.face([f0, f1, b1, b0], 'Slate', out=st.out(1.0))
    B.face([st.p(u0 - 0.1, 0.02, zc), f0, b0], 'Slate', out=(-st.t.x, -st.t.y, 0.8))
    B.face([f1, st.p(u1 + 0.1, 0.02, zc), b1], 'Slate', out=(st.t.x, st.t.y, 0.8))
    # above it the fourth floor in sandstone with one arched window, under a low shoulder of the stone gable
    stone = Wall(st.p(0, 0.01), st.p(st.L, 0.01))
    arched_window(B, stone, (u0 + u1) / 2, FLOORS[3] + 1.35, 1.0, 1.1, 'WinOld', frame='Stucco')
    r = (u1 - u0) / 2 + 0.3
    outline = [(u0 - 0.3, Z_EAVE - 0.01), (u1 + 0.3, Z_EAVE - 0.01)] + [
        ((u0 + u1) / 2 + r * math.cos(math.pi * k / 12), Z_EAVE + 1.5 * math.sin(math.pi * k / 12)) for k in range(13)]
    slab(B, st, outline, -0.6, 0.01, 'Sandstone', side_mat='Sandstone')


def centre_part(B, st):
    u0, u1 = CENTRE
    # sandstone gable rising above the eaves (segmental outline), 0.6 m thick
    g0, g1, apex = GABLE
    gc, gr = (g0 + g1) / 2, (g1 - g0) / 2
    outline = [(g0, Z_EAVE - 0.01), (g1, Z_EAVE - 0.01)] + [
        (gc + gr * math.cos(math.pi * k / 16), Z_EAVE + (apex - Z_EAVE) * math.sin(math.pi * k / 16)) for k in range(17)]
    slab(B, st, outline, -0.6, 0.01, 'Sandstone', side_mat='Sandstone')
    obox(B, st, gc - 0.3, gc + 0.3, -0.62, 0.12, apex - 0.3, apex + 0.35, 'Sandstone')  # crowning stone
    # white field with a round-arched top, blue edges
    outline = [(u0, Z_BAND), (u1, Z_BAND), (u1, ARCH_SPRING)] + [
        (ARCH_C + ARCH_R * math.cos(math.pi * k / 16), ARCH_SPRING + ARCH_R * math.sin(math.pi * k / 16)) for k in range(17)] + \
        [(u0, ARCH_SPRING)]
    B.face([st.p(u, 0.04, z) for u, z in outline], 'Render', out=st.out())
    for u in (u0, u1):
        blue_edge(B, st, u, Z_BAND, ARCH_SPRING, 0.04, 0.08)
    for k in range(16):
        a0, a1 = math.pi * k / 16, math.pi * (k + 1) / 16
        r0, r1 = ARCH_R, ARCH_R + 0.08
        B.face([st.p(ARCH_C + r0 * math.cos(a0), 0.06, ARCH_SPRING + r0 * math.sin(a0)),
                st.p(ARCH_C + r1 * math.cos(a0), 0.06, ARCH_SPRING + r1 * math.sin(a0)),
                st.p(ARCH_C + r1 * math.cos(a1), 0.06, ARCH_SPRING + r1 * math.sin(a1)),
                st.p(ARCH_C + r0 * math.cos(a1), 0.06, ARCH_SPRING + r0 * math.sin(a1))], 'Blue', out=st.out())
    # two window axes, stucco ornament between them, arched windows on the top floor and in the arch
    field = Wall(st.p(0, 0.04), st.p(st.L, 0.04))  # (the white field's plane: the arched windows stand in front of it)
    for k, zf in enumerate(FLOORS):
        for u in (10.25, 12.85):
            if k < 3:
                window(B, st, u, zf + 0.9, 1.2, 1.9, 'WinTall', d=0.05)
            else:
                arched_window(B, field, u, zf + 0.8, 1.05, 1.4, 'WinOld')
    arched_window(B, field, ARCH_C, 17.2, 0.9, 0.9, 'WinOld')
    obox(B, st, ARCH_C - 0.2, ARCH_C + 0.2, -0.02, 0.1, 6.0, 15.6, 'Stucco')  # central pilaster strip
    for z in (7.4, 10.6):
        obox(B, st, ARCH_C - 0.45, ARCH_C + 0.45, -0.02, 0.14, z, z + 0.5, 'Stucco')
    ring_o = arch_pts(st, ARCH_C, 13.5, 0.62, 0.1, 16, 0, 2 * math.pi)[:-1]
    B.face(ring_o, 'Stucco', out=st.out())  # medallion
    ring_i = arch_pts(st, ARCH_C, 13.5, 0.4, 0.12, 12, 0, 2 * math.pi)[:-1]
    B.face(ring_i, 'Blue', out=st.out())
    # stucco garlands under the first-floor windows
    for u in (10.25, 12.85):
        obox(B, st, u - 0.75, u + 0.75, -0.02, 0.1, FLOORS[0] + 0.3, FLOORS[0] + 0.7, 'Stucco')


def oriel(B, st):
    u0, u1, depth, ch = ORIEL
    z0, z1 = Z_BAND, 16.6
    # console band under the oriel and the right field (the projecting balcony band in the photo)
    obox(B, st, u0 - 0.2, 21.1, -0.02, depth + 0.25, Z_BAND - 0.55, Z_BAND, 'Stucco', bottom=True)
    obox(B, st, u0 - 0.2, 21.1, depth + 0.2, depth + 0.27, Z_BAND - 0.5, Z_BAND - 0.1, 'Stucco')
    base = [st.p(u0, 0), st.p(u1, 0), st.p(u1 - ch, depth), st.p(u0 + ch, depth)]
    prism(B, base, z0, z1, 'Render')
    front = Wall(st.p(u0 + ch, depth), st.p(u1 - ch, depth))
    left = Wall(st.p(u0, 0), st.p(u0 + ch, depth))
    right = Wall(st.p(u1 - ch, depth), st.p(u1, 0))
    for p in (st.p(u0, 0.03), st.p(u0 + ch, depth + 0.03), st.p(u1 - ch, depth + 0.03), st.p(u1, 0.03)):
        prism(B, [(p[0] - 0.055, p[1] - 0.055), (p[0] + 0.055, p[1] - 0.055), (p[0] + 0.055, p[1] + 0.055),
                  (p[0] - 0.055, p[1] + 0.055)], z0, z1, 'Blue')
    for k, zf in enumerate(FLOORS):
        for du in (-1.05, 0.0, 1.05):
            if k < 2:
                window(B, front, front.L / 2 + du, zf + 0.9, 0.82, 1.9, 'WinTall', head=False)
            else:
                arched_window(B, front, front.L / 2 + du, zf + 0.85, 0.82, 1.5, 'WinOld')
        for s in (left, right):
            window(B, s, s.L / 2, zf + 0.9, 0.42, 1.9, 'WinTall', frame=None)
        obox(B, front, 0.15, front.L - 0.15, -0.02, 0.08, zf + 0.35, zf + 0.6, 'Stucco')
    # cornice ring and slate helm with a finial
    ring = [st.p(u0 - 0.2, 0), st.p(u1 + 0.2, 0), st.p(u1 - ch + 0.05, depth + 0.2), st.p(u0 + ch - 0.05, depth + 0.2)]
    prism(B, ring, z1, z1 + 0.3, 'Stucco', bottom=True)
    zb, za = z1 + 0.3, z1 + 3.2
    back = [st.p(u0 - 0.2, -1.2), st.p(u1 + 0.2, -1.2)]
    apex0, apex1 = V(st.p(u0 + 1.2, depth * 0.3)), V(st.p(u1 - 1.2, depth * 0.3))
    # hipped helm: front slope, two hips, rising into the main roof
    B.face([(*ring[3], zb), (*ring[2], zb), (apex1.x, apex1.y, za), (apex0.x, apex0.y, za)], 'Slate', out=st.out(1.0))
    B.face([(*ring[0], zb), (*ring[3], zb), (apex0.x, apex0.y, za)], 'Slate', out=tuple(V(left.out()) + V((0, 0, 0.8))))
    B.face([(*ring[2], zb), (*ring[1], zb), (apex1.x, apex1.y, za)], 'Slate', out=tuple(V(right.out()) + V((0, 0, 0.8))))
    B.face([(*ring[0], zb), (apex0.x, apex0.y, za), (*back[0], za)], 'Slate', out=(-st.t.x, -st.t.y, 0))
    B.face([(*ring[1], zb), (*back[1], za), (apex1.x, apex1.y, za)], 'Slate', out=(st.t.x, st.t.y, 0))
    B.face([(apex0.x, apex0.y, za), (apex1.x, apex1.y, za), (*back[1], za), (*back[0], za)], 'Slate', out=(0, 0, 1))
    for a in (apex0, apex1):  # finials
        prism(B, [(a.x - 0.05, a.y - 0.05), (a.x + 0.05, a.y - 0.05), (a.x + 0.05, a.y + 0.05), (a.x - 0.05, a.y + 0.05)],
              za, za + 1.1, 'Zinc', top='Zinc')
        prism(B, [(a.x - 0.12, a.y - 0.12), (a.x + 0.12, a.y - 0.12), (a.x + 0.12, a.y + 0.12), (a.x - 0.12, a.y + 0.12)],
              za + 0.5, za + 0.7, 'Zinc', top='Zinc', bottom=True)


def right_part(B, st):
    panel(B, st, 19.8, 21.2, Z_BAND, 17.0, 'Render', 0.03)
    for zf in FLOORS:
        window(B, st, 20.5, zf + 0.9, 0.85, 1.9, 'WinTall', d=0.05)
    blue_edge(B, st, 21.2, Z_BAND, 17.0, 0.03, 0.08)


def roof(B, st):
    """Gable roof between the fire walls, ridge parallel to the street; main cornice; dormers; chimneys."""
    e0, e1, w0, w1, r0, r1 = E(0), E(L_ST), W(0), W(L_ST), R(0), R(L_ST)
    B.face([(*e0, Z_EAVE), (*e1, Z_EAVE), (*r1, Z_RIDGE), (*r0, Z_RIDGE)], 'Slate', out=st.out(1.2))
    back = Wall(NW, SW)
    B.face([(*w1, Z_EAVE), (*w0, Z_EAVE), (*r0, Z_RIDGE), (*r1, Z_RIDGE)], 'Slate', out=back.out(1.2))
    B.face([(*w0, Z_EAVE), (*e0, Z_EAVE), (*r0, Z_RIDGE)], 'Render', out=(0, -1, 0))  # fire wall gables
    B.face([(*e1, Z_EAVE), (*w1, Z_EAVE), (*r1, Z_RIDGE)], 'Render', out=(0, 1, 0))
    ridge = Wall(r0, r1)
    obox(B, ridge, 0, ridge.L, -0.12, 0.12, Z_RIDGE - 0.05, Z_RIDGE + 0.1, 'Zinc')
    # main cornice on the street face (skipping the gables) and on the back
    for a, b in ((0.0, BAY[0] - 0.1), (BAY[1] + 0.1, GABLE[0]), (GABLE[1], ORIEL[0] - 0.2), (ORIEL[1] + 0.2, st.L)):
        obox(B, st, a, b, -0.02, 0.4, Z_EAVE - 0.35, Z_EAVE, 'Stucco')
    obox(B, back, 0, back.L, -0.02, 0.3, Z_EAVE - 0.3, Z_EAVE, 'Stucco')
    # dormers on the street slope
    depth = (V(R(0)) - V(E(0))).length
    slope = (Z_RIDGE - Z_EAVE) / depth
    for u in (2.45, 20.5):
        d0, d1 = -0.9, -3.2
        zf = Z_EAVE + slope * 0.9 - 0.1
        obox(B, st, u - 0.75, u + 0.75, d1, d0, zf, zf + 1.9, 'Render')
        dm = Wall(st.p(u - 0.75, d0), st.p(u + 0.75, d0))
        window(B, dm, 0.75, zf + 0.35, 0.8, 1.2, 'WinOld', frame=None, sill='Zinc')
        obox(B, st, u - 0.85, u + 0.85, d1, d0 + 0.12, zf + 1.9, zf + 2.05, 'Zinc')
    # chimneys on the ridge
    for u in (5.0, 16.0):
        c = V(R(u))
        prism(B, [(c.x - 0.4, c.y - 0.3), (c.x + 0.4, c.y - 0.3), (c.x + 0.4, c.y + 0.3), (c.x - 0.4, c.y + 0.3)],
              Z_RIDGE - 1.0, Z_RIDGE + 1.2, 'Chimney', top='RoofDark')


def back_face(B):
    """The courtyard face (photos from the yard): yellow brick, three storeys of arched windows over the passage and
    a wide ground-floor window, a slate mansard with dormers as the top floor. The wings of the yard
    (../erft-haus-hof) cover its ends."""
    back = Wall(NW, SW)  # u from the north end
    pa, pb = back.L - P1, back.L - P0
    axes = [7.6, (pa + pb) / 2, 15.9]
    z_m = FLOORS[3] + 0.2  # the mansard's foot
    for u0, u1 in ((0.0, pa - 0.3), (pb + 0.3, back.L)):  # grey plinth, left and right of the passage
        panel(B, back, u0, u1, 0.0, 1.0, 'Paving', 0.03)
    for zf in FLOORS[:3]:
        for u in axes:
            window(B, back, u, zf + 0.9, 1.25, 2.05, 'WinHof', 0.03, sill='Stucco', frame=None)
        window(B, back, 5.2, zf + 1.5 - (zf - FLOORS[0]) * 0.12, 0.6, 1.6, 'WinHof', 0.03, sill='Stucco', frame=None)  # stairwell
    panel(B, back, 6.4, 8.8, 1.1, 3.3, 'Shop', 0.03, UV01)  # the lit ground-floor window left of the passage
    obox(B, back, 6.3, 8.9, -0.02, 0.1, 1.0, 1.1, 'Stucco')
    panel(B, back, pb + 1.2, pb + 2.2, 0.0, 2.3, 'DoorWood', 0.03)
    # cornice, then the mansard: a slate skirt standing out at its foot, a dormer over every axis
    obox(B, back, 0.0, back.L, -0.02, 0.5, z_m - 0.25, z_m, 'Klinker', top='Zinc')
    B.face([back.p(0.0, 0.45, z_m), back.p(back.L, 0.45, z_m), back.p(back.L, 0.03, Z_EAVE), back.p(0.0, 0.03, Z_EAVE)], 'Slate',
           out=back.out(0.3))
    for u in axes:
        obox(B, back, u - 0.75, u + 0.75, 0.0, 0.6, z_m + 0.5, z_m + 2.25, 'Zinc', top='Zinc')
        panel(B, back, u - 0.62, u + 0.62, z_m + 0.62, z_m + 2.13, lit_mat('WinTall'), 0.62, UV01)


def build(B):
    st = Wall(SE, NE)
    body(B)
    passage(B)
    ground_floor(B, st)
    left_part(B, st)
    centre_part(B, st)
    oriel(B, st)
    right_part(B, st)
    roof(B, st)
    back_face(B)


def build_collision(C):
    prism(C, [W(0), E(0), E(P0), W(P0)], SINK, Z_EAVE, 'x', top='x')
    prism(C, [W(P1), E(P1), E(L_ST), W(L_ST)], SINK, Z_EAVE, 'x', top='x')
    prism(C, [W(P0), E(P0), E(P1), W(P1)], Z_PASS, Z_EAVE, 'x', top='x', bottom=True)
    q = [W(P0), E(P0), E(P1), W(P1)]
    C.face([(q[1][0], q[1][1], 0.12), (q[2][0], q[2][1], 0.12), (q[3][0], q[3][1], 0.0), (q[0][0], q[0][1], 0.0)], 'x',
           out=(0, 0, 1))
    st, back = Wall(SE, NE), Wall(NW, SW)
    e0, e1, w0, w1, r0, r1 = E(0), E(L_ST), W(0), W(L_ST), R(0), R(L_ST)
    C.face([(*e0, Z_EAVE), (*e1, Z_EAVE), (*r1, Z_RIDGE), (*r0, Z_RIDGE)], 'x', out=st.out(1.2))
    C.face([(*w1, Z_EAVE), (*w0, Z_EAVE), (*r0, Z_RIDGE), (*r1, Z_RIDGE)], 'x', out=back.out(1.2))
    C.face([(*w0, Z_EAVE), (*e0, Z_EAVE), (*r0, Z_RIDGE)], 'x', out=(0, -1, 0))
    C.face([(*e1, Z_EAVE), (*w1, Z_EAVE), (*r1, Z_RIDGE)], 'x', out=(0, 1, 0))
    # reveals of the passage opening (the ground floor's only parts in front of the facade)
    for u0 in (P0 - 0.35, P1):
        obox(C, st, u0, u0 + 0.35, -0.02, 0.12, SINK, Z_PASS, 'x')


def main():
    assert ccw(list(FOOT)) == list(FOOT), FOOT
    coll = reset_collection('ERFT_HAUS')
    B = Builder(make_materials())
    build(B)
    ob = B.to_object(NAME, coll)
    C = Builder()
    build_collision(C)
    col = C.to_object(f'{NAME}_col', coll)
    col.display_type = 'WIRE'
    col.hide_render = True
    # terrain cut under the passage floor (the service way draped on the terrain would lie on top of it otherwise)
    T = Builder()
    q = [W(P0), E(P0), E(P1), W(P1)]
    T.face([(q[1][0], q[1][1], 0.12), (q[2][0], q[2][1], 0.12), (q[3][0], q[3][1], 0.0), (q[0][0], q[0][1], 0.0)], 'x', out=(0, 0, 1))
    cut = T.to_object(f'{NAME}_cut', coll)
    cut.display_type = 'WIRE'
    cut.hide_render = True
    return ob, col, cut


ob, col, cut = main()
stats = {'tris': tris(ob), 'col_tris': tris(col)}
print('STATS', stats)
if globals().get('EXPORT', True):
    export_glb(os.path.join(HERE, f'{NAME}.glb'), [ob, col, cut])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'), copy=True)
