"""Tribüne on Wilhelmplatz (Köln-Nippes): replaces DENW37AL1000APxJ, …BdpH and …Bdpd.

A rounded, one-storey base (WC, kiosk, store rooms) with roof terraces behind railings; cut into its
south side a wide concrete grandstand (8 sitting steps) between two pylons, a higher block with a tall
back wall behind it, and a thin steel canopy on the pylons and two slender front columns.
Footprint and heights from LOD2, the rest from street photos.

Run inside Blender:  exec(open(PATH).read(), {'__file__': PATH})
Local frame: u along the front (≈ east), v towards the back (≈ north), z up; see nnmodel.py / README.md.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from graffiti import graffiti_atlas  # noqa: E402
from nnmodel import (V, Builder, _blur_noise, _img, box, ccw, edges, export_glb, flat, material,  # noqa: E402
                     prism, reset_collection, tris, wall_frame)

GRAFFITI, GRAFFITI_UV = graffiti_atlas(seed=7)

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'wilhelmplatz-tribuene'
ORIGIN = (-0.3, 20.5)          # Blender XY of the local origin (centre of the grandstand's back line)
THETA = math.radians(11.0)
SINK = -0.3
Z_BASE = 3.5                   # base roof / terrace level
STAND = (-3.6, 3.6, -4.9, -0.4)  # grandstand u0, u1, front v, top v
STEPS = 8
PYLONS = [(-5.37, -3.6), (3.35, 5.06)]  # u ranges, v -0.8..0.7
Z_CANOPY = 7.65
CANOPY = (-5.7, 5.5, -5.35, 1.3)
FRONT_COLS = [(-3.3, -4.55), (3.05, -4.55)]

# outline of the base (CCW): grandstand notch, east curve, straight north wall, west curve
EAST = [(3.6, -4.33), (4.92, -4.19), (6.87, -3.18), (9.0, -1.02), (9.68, 1.64), (8.81, 4.01), (7.23, 5.64),
        (5.0, 6.85), (2.83, 7.53)]
WEST = [(-3.24, 7.51), (-5.32, 6.88), (-7.57, 5.64), (-9.09, 4.13), (-9.92, 2.41), (-9.91, 0.35), (-9.11, -1.41),
        (-7.61, -2.88), (-6.06, -3.87), (-5.25, -4.21), (-4.67, -4.4)]
NOTCH = [(-3.6, -4.4), (-3.6, 0.0), (3.6, 0.0)]  # the grandstand sits in here, up to the back wall


def chaikin(chain, iters=3):
    """Corner cutting on an open polyline (end points kept)."""
    pts = [V(p) for p in chain]
    for _ in range(iters):
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out += [a * 0.75 + b * 0.25, a * 0.25 + b * 0.75]
        out.append(pts[-1])
        pts = out
    return [(p.x, p.y) for p in pts]


EAST_S = chaikin(EAST)
WEST_S = chaikin(WEST)
OUTLINE = NOTCH + EAST_S + WEST_S  # closes back to NOTCH[0]


# ---------------------------------------------------------------- textures / materials

def render_texture(name, base, seed, size=512, stain=0.10):
    """Rendered/painted concrete: fine grain, soft blotches, darker streaks running down."""
    rng = np.random.default_rng(seed)
    img = np.ones((size, size, 3), np.float32) * np.array(base, np.float32)
    img *= (1 + 0.05 * _blur_noise(rng, size, 8))[..., None]
    img *= (1 + 0.03 * _blur_noise(rng, size, 32))[..., None]
    streak = _blur_noise(rng, size, 24)[:1, :].repeat(size, 0)  # constant down each column
    img *= (1 - stain * np.clip(streak, 0, 1))[..., None]
    img += rng.normal(0, 0.012, img.shape)
    return _img(name, img)


def glassblock_texture(name, size=256, n=8):
    """n×n glass blocks: pale blue-grey, lighter centres, dark grout."""
    c = size // n
    yy, xx = np.mgrid[0:size, 0:size]
    fx, fy = (xx % c) / c - 0.5, (yy % c) / c - 0.5
    r = np.sqrt(fx ** 2 + fy ** 2)
    img = np.empty((size, size, 3), np.float32)
    img[:] = (0.55, 0.62, 0.66)
    img *= (1.15 - 0.6 * r)[..., None]
    grout = (np.abs(fx) > 0.44) | (np.abs(fy) > 0.44)
    img[grout] = (0.45, 0.45, 0.44)
    return _img(name, img)


def grille_texture(name, w=128, h=256):
    """Steel grille door: dark interior behind vertical bars, frame and a cross bar."""
    img = np.empty((h, w, 3), np.float32)
    img[:] = (0.10, 0.10, 0.11)
    xx = np.arange(w)
    img[:, (xx % 12) < 3] = (0.48, 0.49, 0.50)
    img[:6], img[-6:], img[:, :6], img[:, -6:] = 0.52, 0.52, 0.52, 0.52
    img[h // 2 - 3:h // 2 + 3] = 0.52
    return _img(name, img)


def make_materials():
    render = render_texture('tex_render', (0.76, 0.76, 0.74), 21)
    concrete = render_texture('tex_concrete', (0.56, 0.56, 0.54), 22, stain=0.18)
    return {
        'Render': material('Render', image=render, rough=0.9),
        'Coping': material('Coping', (0.86, 0.86, 0.84), 0.8),
        'Concrete': material('Concrete', image=concrete, rough=0.9),
        'RoofDark': material('RoofDark', (0.24, 0.24, 0.24), 0.95),
        'RoofLight': material('RoofLight', (0.68, 0.68, 0.67), 0.85),
        'SteelDark': material('SteelDark', (0.23, 0.24, 0.25), 0.5, 0.6),
        'SteelLight': material('SteelLight', (0.70, 0.71, 0.72), 0.5, 0.6),
        'Railing': material('Railing', (0.62, 0.63, 0.64), 0.45, 0.7),
        'GlassBlock': material('GlassBlock', image=glassblock_texture('tex_glassblock'), rough=0.25),
        'Grille': material('Grille', image=grille_texture('tex_grille'), rough=0.6, metal=0.4),
        'GreenPaint': material('GreenPaint', (0.16, 0.42, 0.24), 0.7),
        'KioskDark': material('KioskDark', (0.13, 0.14, 0.15), 0.6),
        'GlassModern': material('GlassModern', (0.10, 0.12, 0.14), 0.15),
        'Awning': material('Awning', (0.88, 0.88, 0.85), 0.8),
        'Graffiti': material('Graffiti', image=_img('tex_graffiti', GRAFFITI), rough=0.75, clip=True),
    }


# ---------------------------------------------------------------- helpers

def arclen(chain):
    s = [0.0]
    for a, b in zip(chain, chain[1:]):
        s.append(s[-1] + (V(b) - V(a)).length)
    return s


def s_near(chain, p):
    """Arc length of the chain point closest to p."""
    s = arclen(chain)
    best = (1e9, 0.0)
    for i, (a, b) in enumerate(zip(chain, chain[1:])):
        a, b = V(a), V(b)
        d = b - a
        t = max(0.0, min(1.0, (V(p) - a).dot(d) / d.length_squared))
        best = min(best, ((a + d * t - V(p)).length, s[i] + t * d.length))
    return best[1]


def strip(B, chain, s0, s1, z0, z1, mat, d=0.05, uv_w=None, uv_rect=(0, 0, 1, 1)):
    """Panel following a CCW wall chain from arc length s0 to s1 (curved walls), `d` in front of it.
    uv_w: metres per texture repeat along the wall (None = the panel spans uv_rect)."""
    s = arclen(chain)
    for i, (a, b) in enumerate(zip(chain, chain[1:])):
        lo, hi = max(s0, s[i]), min(s1, s[i + 1])
        if hi - lo < 1e-4:
            continue
        a2, t, n = wall_frame(a, b)
        p, q = a2 + t * (lo - s[i]) + n * d, a2 + t * (hi - s[i]) + n * d
        if uv_w:
            us = (lo - s0) / uv_w, (hi - s0) / uv_w
            vs = 0.0, (z1 - z0) / uv_w
        else:
            us = (lo - s0) / (s1 - s0), (hi - s0) / (s1 - s0)
            vs = 0.0, 1.0
        if not uv_w:
            r0, r1, r2, r3 = uv_rect
            us = tuple(r0 + (r2 - r0) * x for x in us)
            vs = tuple(r1 + (r3 - r1) * x for x in vs)
        B.face([(p.x, p.y, z0), (q.x, q.y, z0), (q.x, q.y, z1), (p.x, p.y, z1)], mat, out=(n.x, n.y, 0),
               uvs=[(us[0], vs[0]), (us[1], vs[0]), (us[1], vs[1]), (us[0], vs[1])])


def bar(B, a, b, z0, z1, w, mat, top=True):
    """Square-section bar of width w from a to b (2D) between z0 and z1."""
    a, b = V(a), V(b)
    t = (b - a).normalized()
    n = V((t.y, -t.x)) * (w / 2)
    prism(B, [a - n, b - n, b + n, a + n], z0, z1, mat, top=mat if top else None)


def post(B, p, z0, z1, w, mat):
    p = V(p)
    box(B, p.x - w / 2, p.x + w / 2, p.y - w / 2, p.y + w / 2, z0, z1, mat, top=mat)


def railing(B, chain, z0, inset=0.15, h=1.1, post_every=1.8, bar_every=0.13):
    """Steel railing set back `inset` from a CCW wall chain: posts, top and bottom rail, vertical bars."""
    pts = []
    for i, p in enumerate(chain):  # offset inwards (left of the walking direction)
        a = V(chain[max(i - 1, 0)])
        b = V(chain[min(i + 1, len(chain) - 1)])
        t = (b - a).normalized()
        pts.append(V(p) + V((-t.y, t.x)) * inset)
    s = arclen(pts)
    for a, b in zip(pts, pts[1:]):
        bar(B, a, b, z0 + h - 0.05, z0 + h, 0.05, 'Railing')
        bar(B, a, b, z0 + 0.08, z0 + 0.12, 0.04, 'Railing', top=False)
    for k in range(int(s[-1] / post_every) + 1):
        post(B, at(pts, s, min(k * post_every, s[-1])), z0, z0 + h, 0.06, 'Railing')
    for k in range(1, int(s[-1] / bar_every)):
        p = at(pts, s, k * bar_every)
        box(B, p.x - 0.012, p.x + 0.012, p.y - 0.012, p.y + 0.012, z0 + 0.12, z0 + h - 0.05, 'Railing', top=None)
    post(B, pts[-1], z0, z0 + h, 0.06, 'Railing')


def at(pts, s, x):
    for i in range(len(pts) - 1):
        if s[i + 1] >= x:
            t = (x - s[i]) / max(s[i + 1] - s[i], 1e-9)
            return pts[i] + (pts[i + 1] - pts[i]) * t
    return pts[-1]


def column(B, p, z0, z1, r, mat, seg=8):
    prism(B, [(p[0] + r * math.cos(2 * math.pi * k / seg), p[1] + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)],
          z0, z1, mat, top=mat)


# ---------------------------------------------------------------- the tribüne

def outer_chain():
    """Outer wall as one open chain from the east end of the notch round to the west wing's front corner."""
    return EAST_S + WEST_S


def build(B):
    u0, u1, vf, vt = STAND
    # --- base: rendered walls, dark roof, light coping
    prism(B, OUTLINE, SINK, Z_BASE, 'Render', top='RoofDark')
    ch = outer_chain()
    L = arclen(ch)[-1]
    strip(B, ch, 0, L, Z_BASE - 0.3, Z_BASE + 0.12, 'Coping', d=0.04, uv_w=2.0)
    for (pa, pb) in zip(NOTCH, NOTCH[1:]):
        strip(B, [pa, pb], 0, (V(pb) - V(pa)).length, Z_BASE - 0.3, Z_BASE + 0.12, 'Coping', d=0.04, uv_w=2.0)

    # --- openings on the outer wall
    def at_p(p, w, z0, z1, mat, d=0.05, uv_w=None):
        s = s_near(ch, p)
        strip(B, ch, s - w / 2, s + w / 2, z0, z1, mat, d, uv_w)

    # north (Viersener Str.): three steel grille double doors
    for u in (-2.0, 0.0, 2.0):
        at_p((u, 7.6), 1.7, 0.0, 2.55, 'Grille')
        at_p((u, 7.6), 1.9, 2.55, 2.7, 'SteelDark', 0.06)
    # west: WC doors, glass blocks towards the front
    at_p((-9.9, 1.4), 1.0, 0.0, 2.3, 'Grille')
    at_p((-9.3, 3.8), 1.0, 0.0, 2.3, 'Grille')
    at_p((-7.0, -3.3), 3.4, 0.35, 2.9, 'GlassBlock', uv_w=1.52)
    # south-east: kiosk front with window and awning
    s = s_near(ch, (7.4, -2.8))
    strip(B, ch, s - 2.2, s + 2.2, 0.0, 2.75, 'KioskDark', 0.05)
    strip(B, ch, s - 1.6, s + 1.0, 0.9, 2.4, 'GlassModern', 0.07)
    strip(B, ch, s + 1.3, s + 2.0, 0.0, 2.3, 'GlassModern', 0.07)
    awning(B, ch, s - 2.3, s + 2.3, 2.95, 1.1)
    # east: second grille door
    at_p((9.6, 2.2), 1.6, 0.0, 2.5, 'Grille')

    # --- notch walls facing the grandstand (green paint lower part on the east wall)
    # (the steps cover the lower part towards the back; paint shows between them and the front)
    a, t, n = wall_frame((3.6, -0.8), (3.6, -4.33))
    flat(B, a, t, n, 1.75, 3.5, 0.0, 2.7, 'GreenPaint', 0.03)
    a, t, n = wall_frame((-3.6, -4.4), (-3.6, -0.8))
    flat(B, a, t, n, 1.8, 3.6, 0.0, 2.7, 'GreenPaint', 0.03)

    # --- grandstand: stacked steps up to the base roof level, landing at the top
    rise, run = Z_BASE / STEPS, (vt - vf) / STEPS
    for k in range(STEPS):
        box(B, u0, u1, vf + k * run, 0.6, (k * rise) if k else SINK, (k + 1) * rise, 'Concrete')
    # back block (higher, roof falling to the north) and the tall back wall above the landing
    back = [(-5.2, 0.6), (6.5, 0.6), (6.5, 5.6), (-5.2, 6.1)]
    slope_block(B, back, 5.8, 4.4)
    box(B, u0, u1, 0.0, 0.6, Z_BASE - 0.1, 7.0, 'Render')
    box(B, u0 - 0.1, u1 + 0.1, -0.05, 0.6, 6.75, 7.0, 'Concrete')  # beam under the canopy
    # pylons carrying the canopy at the back
    for pu0, pu1 in PYLONS:
        box(B, pu0, pu1, -0.8, 0.7, SINK, Z_CANOPY, 'Render')
    # --- canopy: thin steel plate (light top as seen from above), fascia, two beams, front columns
    cu0, cu1, cv0, cv1 = CANOPY
    prism(B, [(cu0, cv0), (cu1, cv0), (cu1, cv1), (cu0, cv1)], Z_CANOPY + 0.05, Z_CANOPY + 0.22, 'SteelDark',
          top='SteelLight', bottom=True)
    box(B, cu0 - 0.05, cu1 + 0.05, cv0 - 0.05, cv0 + 0.12, Z_CANOPY - 0.12, Z_CANOPY + 0.3, 'SteelDark')
    for cu, _ in FRONT_COLS:
        box(B, cu - 0.12, cu + 0.12, cv0, cv1 - 0.2, Z_CANOPY - 0.3, Z_CANOPY + 0.05, 'SteelDark')
    for p in FRONT_COLS:
        column(B, p, 0.0, Z_CANOPY - 0.3, 0.09, 'SteelDark')
    for cu, _ in FRONT_COLS:  # diagonal struts from the back wall up to the beams
        strut(B, (cu, 0.4), 5.6, (cu, -2.2), Z_CANOPY - 0.3)

    graffiti(B, ch)

    # --- railings: along the terrace edges (outer wall and the notch) and round the back block
    railing(B, ch, Z_BASE)
    railing(B, [(-3.6, -0.8), (-3.6, -4.4)], Z_BASE, inset=-0.15)
    railing(B, [(3.6, -4.33), (3.6, -0.8)], Z_BASE, inset=-0.15)


def decal(B, chain, s, word, width, z0, d=0.08):
    """Graffiti `word` from the atlas, centred at arc length s of a wall chain, height from its aspect."""
    u0, v0, u1, v1 = GRAFFITI_UV[word]
    h = width * (v1 - v0) / (u1 - u0)
    strip(B, chain, s - width / 2, s + width / 2, z0, z0 + h, 'Graffiti', d, uv_rect=(u0, v0, u1, v1))


def graffiti(B, ch):
    """Pieces and tags where the photos have them: back wall, round base, notch walls, a pylon, risers."""
    near = lambda p: s_near(ch, p)
    decal(B, [(-3.6, 0.0), (3.6, 0.0)], 3.6, 'KOLO', 5.2, 4.1)            # back wall above the grandstand
    decal(B, [(-3.6, 0.0), (3.6, 0.0)], 1.0, 'NIX', 1.0, 3.75)
    decal(B, ch, near((6.2, 6.4)), 'NIPPES', 4.4, 0.45)                  # round base, north-east
    decal(B, ch, near((-6.6, 6.1)), 'TRAX', 3.2, 0.5)                    # north-west
    decal(B, ch, near((-9.7, -0.5)), 'ZOFF', 2.4, 0.5)                   # west, between glass blocks and WC
    decal(B, ch, near((9.5, 0.1)), 'SKE', 1.3, 1.0)                      # east, beside the kiosk
    decal(B, ch, near((-2.9, 7.6)), 'RAZ', 1.0, 2.75)                    # above the grille doors
    decal(B, [(3.6, -0.8), (3.6, -4.33)], 2.9, 'KO4', 1.2, 1.2)          # green notch walls
    decal(B, [(-3.6, -4.4), (-3.6, -0.8)], 0.9, 'ZET', 1.1, 0.9)
    decal(B, [(-5.37, -0.8), (-3.6, -0.8)], 0.88, 'OLE', 1.6, 4.0)        # west pylon above the terrace
    u0, u1, vf, vt = STAND
    rise, run = Z_BASE / STEPS, (vt - vf) / STEPS
    for k, word, s in ((1, 'LUX', 2.2), (3, 'NIX', 5.1)):               # tags on the risers
        v = vf + k * run
        decal(B, [(u0, v), (u1, v)], s, word, 0.75, k * rise + 0.04, d=0.02)


def slope_block(B, poly, z_front, z_back, mat='Render', roof='RoofLight'):
    """Block on the base whose flat roof falls from v = poly[0].v (z_front) to the back (z_back)."""
    poly = ccw([V(p) for p in poly])
    v0 = min(p.y for p in poly)
    v1 = max(p.y for p in poly)
    z = lambda p: z_front + (z_back - z_front) * (p.y - v0) / (v1 - v0)
    for a, b, t, n in edges(poly):
        B.face([(a.x, a.y, Z_BASE - 0.1), (b.x, b.y, Z_BASE - 0.1), (b.x, b.y, z(b)), (a.x, a.y, z(a))], mat, out=(n.x, n.y, 0))
    B.face([(p.x, p.y, z(p)) for p in poly], roof, out=(0, 0, 1))
    if mat == 'x':  # collision: no trim
        return
    for a, b, t, n in edges(poly):  # coping
        B.face([(a.x, a.y, z(a) - 0.25), (b.x, b.y, z(b) - 0.25), (b.x, b.y, z(b) + 0.05), (a.x, a.y, z(a) + 0.05)],
               'Coping', out=(n.x, n.y, 0), uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])


def strut(B, a, za, b, zb, w=0.12, mat='SteelDark'):
    """Square steel strut between (a, za) and (b, zb) (a, b 2D points with the same u)."""
    a, b = V(a), V(b)
    hw = w / 2
    pts = [(a.x - hw, a.y, za - hw), (a.x + hw, a.y, za - hw), (b.x + hw, b.y, zb - hw), (b.x - hw, b.y, zb - hw)]
    up = [(x, y, z + w) for x, y, z in pts]
    B.face(pts, mat, out=(0, 0, -1))
    B.face(up, mat, out=(0, 0, 1))
    B.face([pts[0], pts[3], up[3], up[0]], mat, out=(-1, 0, 0))
    B.face([pts[1], pts[2], up[2], up[1]], mat, out=(1, 0, 0))


def awning(B, chain, s0, s1, z, depth, drop=0.35):
    """Kiosk awning following a curved wall, both sides rendered."""
    s = arclen(chain)
    for i, (a, b) in enumerate(zip(chain, chain[1:])):
        lo, hi = max(s0, s[i]), min(s1, s[i + 1])
        if hi - lo < 1e-4:
            continue
        a2, t, n = wall_frame(a, b)
        p, q = a2 + t * (lo - s[i]), a2 + t * (hi - s[i])
        quad = [(p.x, p.y, z), (q.x, q.y, z), (q.x + n.x * depth, q.y + n.y * depth, z - drop),
                (p.x + n.x * depth, p.y + n.y * depth, z - drop)]
        B.face(quad, 'Awning', out=(n.x * 0.3, n.y * 0.3, 1))
        B.face(quad, 'Awning', out=(-n.x * 0.3, -n.y * 0.3, -1))


def build_collision(B):
    u0, u1, vf, vt = STAND
    prism(B, OUTLINE, SINK, Z_BASE, 'x', top='x')
    rise, run = Z_BASE / STEPS, (vt - vf) / STEPS
    for k in range(STEPS):
        box(B, u0, u1, vf + k * run, 0.6, SINK, (k + 1) * rise, 'x')
    slope_block(B, [(-5.2, 0.6), (6.5, 0.6), (6.5, 5.6), (-5.2, 6.1)], 5.8, 4.4, 'x', 'x')
    box(B, u0, u1, 0.0, 0.6, Z_BASE - 0.1, 7.0, 'x')
    for pu0, pu1 in PYLONS:
        box(B, pu0, pu1, -0.8, 0.7, SINK, Z_CANOPY, 'x')
    cu0, cu1, cv0, cv1 = CANOPY
    box(B, cu0, cu1, cv0, cv1, Z_CANOPY - 0.12, Z_CANOPY + 0.3, 'x')
    for p in FRONT_COLS:
        box(B, p[0] - 0.1, p[0] + 0.1, p[1] - 0.1, p[1] + 0.1, 0.0, Z_CANOPY, 'x')
    for side in (-1, 1):  # terrace railings: thin walls along the notch so nobody walks off
        u = 3.6 * side - 0.15 * side
        box(B, u - 0.03, u + 0.03, -4.4, -0.8, Z_BASE, Z_BASE + 1.1, 'x')


def main():
    coll = reset_collection('TRIBUENE')
    B = Builder(make_materials())
    build(B)
    ob = B.to_object(NAME, coll, ORIGIN, THETA)
    C = Builder()
    build_collision(C)
    col = C.to_object(f'{NAME}_col', coll, ORIGIN, THETA)
    col.display_type = 'WIRE'
    col.hide_render = True
    return ob, col


ob, col = main()
stats = {'tris': tris(ob), 'col_tris': tris(col)}
if globals().get('EXPORT', True):
    export_glb(os.path.join(HERE, f'{NAME}.glb'), [ob, col])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'), copy=True)
