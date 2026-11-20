"""Erft-Haus courtyard (Neusser Str. 27–29, Köln-Neustadt-Nord): the yard behind the front house and what stands round it.

Replaces three LOD2 buildings that stand entirely in the yard:
  DENW37AL1000eYtc  the stair tower (chamfered corners) with the glass porch at its foot
  DENW37AL1000eTgk  the north wing (yellow brick, mansard with dormers, house door with steel stairs)
  DENW37AL1000eapc  the south wing (the same, blank gable to the west)
  DENW37AL1000eW6M  the white-painted building in the north (big steel windows, the top floor glazed almost up to the
                    roof, a small roof terrace at its east corner); its sides away from the yard are plain brick
and adds, without replacing anything:
  · the lift shaft (white cladding, "ERFTHAUS" sign frame) beside the tower
  · facades standing 6 cm in front of the LOD2 walls of the big neighbours, which stay as they are on their other
    sides: the factory building in the west (eVA9: arched steel windows, the KIESER entrance, the garage gate), the
    building in the south (eYSo) and the low white shed (eUni)
  · the ground: paving slabs, the asphalt ramp down to the underground garage between two curved brick walls with
    railings, planting beds with shrubs and boulders, bollards, a poster stand (the two trees in the beds are the
    game's own: YARD_TREES in packages/pipeline/src/main.ts)
The front house's own courtyard face is part of ../erft-haus.
Footprints and heights from LOD2, the ramp from DGM1, everything else from photos taken in the yard (Nov 2026).

Run inside Blender:  exec(open(PATH).read(), {'__file__': PATH})
World coordinates: Blender X = game x, Blender Y = −game z (north); z 0 = the yard (LOD2 base 49.3 m).
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils.geometry import tessellate_polygon

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from graffiti import GLYPHS  # noqa: E402
from nnmodel import (V, Builder, _blur_noise, _img, brick_texture, ccw, edges, export_glb, grid_window_texture, material, prism,  # noqa: E402
                     reset_collection, see_through, slate_texture, tris, wall_frame)

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'erft-haus-hof'
SINK = -0.3
RNG = np.random.default_rng(1927)
SKIN = 0.06  # facades of kept LOD2 buildings stand this far in front of their walls

# ---------------------------------------------------------------- plan (Blender XY, from LOD2)

# west: the factory building's east face, north → south
A0, A1, A2, A3, A4 = (259.8, -1201.1), (260.0, -1203.5), (260.5, -1208.7), (261.0, -1215.2), (261.7, -1223.1)
TOWER = [(260.5, -1208.7), (263.8, -1208.5), (265.0, -1209.4), (265.3, -1213.5), (264.2, -1215.0), (261.0, -1215.2)]
# north: the white building's south face, then the north wing
N1, N2, N3 = (270.6, -1200.2), (273.4, -1200.4), (275.1, -1200.5)
WING_N = [(275.6, -1194.4), (289.2, -1195.7), (288.8, -1200.1), (288.7, -1201.7), (275.1, -1200.5)]
WING_N_E = [(289.2, -1195.7), (292.7, -1196.0), (292.3, -1200.4), (288.8, -1200.1)]  # its stub at the front house
# the white building's footprint parts (the big one borders the yard), and its roof terrace's inner corner points
WHITE_BIG = [(272.1, -1194.1), (273.4, -1200.4), (270.6, -1200.2), (259.8, -1201.1), (252.5, -1201.7), (250.1, -1191.5), (249.5, -1188.6),
             (256.2, -1187.1), (262.4, -1185.6), (266.4, -1184.8), (270.0, -1184.0)]
WHITE_REST = [[(273.4, -1200.4), (272.1, -1194.1), (275.6, -1194.4), (275.1, -1200.5)],
              [(244.9, -1189.6), (245.5, -1192.5), (238.7, -1194.1), (238.4, -1191.1)],
              [(252.5, -1201.7), (245.8, -1202.3), (239.6, -1202.8), (239.4, -1201.2), (238.7, -1194.1), (245.5, -1192.5), (250.1, -1191.5)]]
TERR_U, Z_TERR = 9.64, 14.6  # the terrace (4 m wide, 3 m deep): from here along the south face to its east end, its floor
T1, T2, T3 = (272.79, -1197.46), (269.16, -1197.31), (269.41, -1200.30)
# south: the south wing, the shed, the southern building
WING_S = [(287.8, -1212.4), (287.7, -1213.3), (287.3, -1218.1), (277.4, -1217.2), (278.0, -1211.5)]
WING_S_E = [(291.1, -1213.6), (290.7, -1218.4), (287.3, -1218.1), (287.7, -1213.3)]  # its stub at the front house
U1, U2, U3 = (273.7, -1216.9), (273.4, -1221.8), (271.8, -1222.15)
Y0 = (271.8, -1222.2)
YSO_E = (274.1, -1232.5)  # the southern building's east wall runs from Y0 to here (seen over the shed)
FRONT_N, FRONT_S = (292.3, -1200.4), (291.1, -1213.6)  # the front house's back between the wings
YARD_C = (276.0, -1207.0)

Z_WEST, Z_WHITE, Z_SOUTH, Z_SHED = 18.5, 19.7, 18.7, 2.8  # wall tops of the kept buildings
Z_TOWER, Z_LIFT = 18.0, 19.4
Z_WING_EAVE, Z_WING_TOP, MANSARD_IN = 15.3, 18.7, 1.1
WING_SILLS = [2.2, 5.5, 8.8, 12.1]  # raised ground floor and three storeys
IND_SILLS = [5.2, 9.5, 13.6]  # the factory's upper storeys
RAMP_SLOPE = 0.22


# ---------------------------------------------------------------- frames

class Wall:
    """Frame on a wall a→b with the yard on its right: u along the wall, d out into the yard, z up."""

    def __init__(self, a, b, d0=0.0):
        self.a, self.t, self.n = wall_frame(a, b)
        self.L = (V(b) - V(a)).to_2d().length
        self.a = self.a + self.n * d0

    def p(self, u, d=0.0, z=None):
        q = self.a + self.t * u + self.n * d
        return (q.x, q.y) if z is None else (q.x, q.y, z)

    def out(self, up=0.0):
        return (self.n.x, self.n.y, up)


UV01 = [(0, 0), (1, 0), (1, 1), (0, 1)]


def panel(B, w, u0, u1, z0, z1, mat, d=0.02, uvs=None):
    B.face([w.p(u0, d, z0), w.p(u1, d, z0), w.p(u1, d, z1), w.p(u0, d, z1)], mat, out=w.out(), uvs=uvs)


def obox(B, w, u0, u1, d0, d1, z0, z1, mat, top=None, bottom=False):
    prism(B, [w.p(u0, d0), w.p(u1, d0), w.p(u1, d1), w.p(u0, d1)], z0, z1, mat, top=top or mat, bottom=bottom)


def beam(B, p, q, w, h, mat):
    """Bar of cross-section w (horizontal) × h between the 3D points p and q (its axis)."""
    p, q = V(p), V(q)
    t = (q - p).normalized()
    side = V((-t.y, t.x, 0))
    side = side.normalized() * (w / 2) if side.length > 1e-6 else V((w / 2, 0, 0))
    up = t.cross(side).normalized() * (h / 2)
    if up.z < 0:
        up = -up
    c = [side + up, -side + up, -side - up, side - up]
    for i in range(4):
        a, b = c[i], c[(i + 1) % 4]
        B.face([p + a, p + b, q + b, q + a], mat, out=tuple(a + b))
    B.face([p + x for x in c], mat, out=tuple(-t))
    B.face([q + x for x in c], mat, out=tuple(t))


def cyl(B, c, r, z0, z1, mat, seg=12, top=None):
    prism(B, [(c[0] + r * math.cos(2 * math.pi * k / seg), c[1] + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)],
          z0, z1, mat, top=top or mat)


def blob(B, c, r, mat, rng, squash=0.8, rough=0.25, rings=5, seg=8, base=0.0):
    """Lumpy ball (a boulder, a shrub, a tree's crown): centre c, radii r (xy) and r·squash (z); `base` cuts it
    off flat this far below the centre (share of the height)."""
    c = V(c)
    grid = []
    for i in range(rings + 1):
        lat = -math.pi / 2 + math.pi * i / rings
        row = []
        for j in range(seg):
            lon = 2 * math.pi * j / seg
            k = 1 + rough * rng.uniform(-1, 1) if 0 < i < rings else 1
            z = max(math.sin(lat) * squash, -base * squash if base else -9)
            row.append(c + V((math.cos(lat) * math.cos(lon) * r * k, math.cos(lat) * math.sin(lon) * r * k, z * r * k)))
        grid.append(row)
    for i in range(rings):
        for j in range(seg):
            a, b, d, e = grid[i][j], grid[i][(j + 1) % seg], grid[i + 1][(j + 1) % seg], grid[i + 1][j]
            pts = [a, b, d, e] if 0 < i < rings - 1 else ([a, d, e] if i == 0 else [a, b, e])
            if (pts[0] - pts[1]).length < 1e-6 or (pts[1] - pts[2]).length < 1e-6:
                continue
            B.face(pts, mat, out=tuple((a + b + d + e) / 4 - c))


def fill(T, outline, z, mat):
    """Horizontal (or, with z a function of x and y, sloping) surface over a simple, possibly concave outline."""
    zf = z if callable(z) else (lambda x, y: z)
    pts = [(x, y, zf(x, y)) for x, y in outline]
    for tri in tessellate_polygon([[V((x, y, 0.0)) for x, y in outline]]):
        T.face([pts[i] for i in tri], mat, out=(0, 0, 1))


def arc(c, r, a0, a1, seg=10):
    return [(c[0] + r * math.cos(a0 + (a1 - a0) * k / seg), c[1] + r * math.sin(a0 + (a1 - a0) * k / seg)) for k in range(seg + 1)]


# ---------------------------------------------------------------- textures and materials

KLINKER = [(0.80, 0.64, 0.38), (0.74, 0.58, 0.34), (0.84, 0.70, 0.44), (0.68, 0.52, 0.31), (0.78, 0.60, 0.40)]


def plain_texture(name, base, seed, size=256, grain=0.02, streak=0.0, cells=8):
    rng = np.random.default_rng(seed)
    img = np.ones((size, size, 3), np.float32) * np.array(base, np.float32)
    img *= (1 + 0.06 * _blur_noise(rng, size, cells))[..., None]
    if streak:
        img *= (1 - streak * np.clip(_blur_noise(rng, size, 24)[:1, :].repeat(size, 0), 0, 1))[..., None]
    img += rng.normal(0, grain, img.shape)
    return _img(name, img)


def cladding_texture(name, size=256, boards=8):
    """White vertical boards with dark joints (the lift shaft)."""
    rng = np.random.default_rng(5)
    xx = np.mgrid[0:size, 0:size][1] / size
    img = np.ones((size, size, 3), np.float32) * np.array((0.90, 0.90, 0.88), np.float32)
    img *= (0.96 + 0.04 * rng.uniform(0, 1, boards)[(xx * boards).astype(int).clip(0, boards - 1)])[..., None]
    img[((xx * boards) % 1) < 0.05] *= 0.72
    img *= (1 - 0.05 * np.clip(_blur_noise(rng, size, 6), 0, 1))[..., None]
    return _img(name, img)


def foliage_texture(name, seed, base=(0.16, 0.30, 0.12), size=256):
    rng = np.random.default_rng(seed)
    n = _blur_noise(rng, size, 24) * 0.6 + _blur_noise(rng, size, 64) * 0.4
    img = np.array(base, np.float32) * (1 + 0.55 * n)[..., None]
    img[..., 1] += 0.05 * _blur_noise(rng, size, 12)
    return _img(name, img)


def grille_texture(name, size=256):
    """Roller grille of the garage gate: bright wire diamonds over the dark behind."""
    yy, xx = np.mgrid[0:size, 0:size] / size
    d = np.minimum(np.abs(((xx * 10 + yy * 14) % 1) - 0.5), np.abs(((xx * 10 - yy * 14) % 1) - 0.5))
    img = np.ones((size, size, 3), np.float32) * 0.05
    img[d < 0.07] = (0.62, 0.63, 0.64)
    return _img(name, img)


def text_texture(name, text, w, h, fg, bg, stroke=0.17):
    """Lettering in the stroke font of graffiti.py, the glyph cells spread evenly over the width."""
    img = np.ones((h, w, 3), np.float32) * np.array(bg, np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    gh = h * 0.6
    step = (w - h * 0.3) / len(text)
    gw = min(gh * 0.72, step * 0.76)
    mask = np.zeros((h, w), bool)
    for i, ch in enumerate(text):
        ox, oy = h * 0.15 + i * step + (step - gw) / 2, (h - gh) / 2
        for line in GLYPHS.get(ch, []):
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                pa, pb = np.array((ox + ax * gw, oy + (1 - ay) * gh)), np.array((ox + bx * gw, oy + (1 - by) * gh))
                d = pb - pa
                t = np.clip(((xx - pa[0]) * d[0] + (yy - pa[1]) * d[1]) / max(d @ d, 1e-6), 0, 1)
                mask |= np.hypot(xx - pa[0] - t * d[0], yy - pa[1] - t * d[1]) < gh * stroke * 0.5
    img[mask] = fg
    return _img(name, img[::-1].copy())  # row 0 at the bottom


def poster_texture(name, seed, base, accent):
    """A poster in the sign frame: a soft figure on a plain ground with a block of lettering."""
    rng = np.random.default_rng(seed)
    h, w = 256, 192
    yy, xx = np.mgrid[0:h, 0:w] / np.array([h, w], np.float32)[:, None, None]
    img = np.ones((h, w, 3), np.float32) * np.array(base, np.float32)
    img += (0.10 * _blur_noise(rng, 256, 5)[:h, :w])[..., None]
    fig = ((xx - 0.5) ** 2 / 0.05 + (yy - 0.6) ** 2 / 0.09) < 1
    img[fig] = img[fig] * 0.5 + 0.5 * np.array((0.96, 0.95, 0.93), np.float32)
    for r in range(4):
        line = (np.abs(yy - (0.26 - r * 0.055)) < 0.014) & (xx > 0.14) & (xx < 0.86 - 0.12 * (r % 2))
        img[line] = accent
    return _img(name, img)


WIN = {  # style → cols, rows, arch, frame colour, glass, curtains, pixel size, variants
    'WinFlat': dict(cols=2, rows=3, arch=0.10, frame=(0.93, 0.93, 0.91), curtains=True, w=128, h=256, n=3),
    'WinDormer': dict(cols=2, rows=2, arch=0.0, frame=(0.93, 0.93, 0.91), curtains=True, w=128, h=128, n=2),
    'WinSteel': dict(cols=4, rows=5, arch=0.09, frame=(0.20, 0.21, 0.22), w=192, h=256, n=3),
    'WinSteelTall': dict(cols=2, rows=5, arch=0.05, frame=(0.20, 0.21, 0.22), w=96, h=256, n=2),
    'WinSteelRect': dict(cols=4, rows=4, arch=0.0, frame=(0.22, 0.23, 0.24), w=192, h=192, n=3),
    'WinStrip': dict(cols=8, rows=3, arch=0.0, frame=(0.22, 0.23, 0.24), w=256, h=96, n=2),
    'WinShop': dict(cols=6, rows=5, arch=0.0, frame=(0.20, 0.21, 0.22), w=256, h=192, n=1, glass=(0.11, 0.12, 0.12)),
}


def make_materials():
    m = {
        'Klinker': material('HofKlinker', image=brick_texture('tex_hof_klinker', KLINKER, (0.62, 0.57, 0.48), 71, soot=0.10), rough=0.9),
        'KlinkerDark': material('HofKlinkerDark', image=brick_texture('tex_hof_klinker_dark', [(0.52, 0.30, 0.22), (0.46, 0.27, 0.20),
                                                                                              (0.58, 0.36, 0.25)], (0.50, 0.46, 0.40), 72), rough=0.9),
        'WhiteBrick': material('HofWhiteBrick', image=brick_texture('tex_hof_white', [(0.93, 0.93, 0.92), (0.90, 0.90, 0.89),
                                                                                    (0.95, 0.95, 0.94)], (0.80, 0.80, 0.79), 73), rough=0.85),
        'Render': material('HofRender', image=plain_texture('tex_hof_render', (0.86, 0.83, 0.74), 74, streak=0.10), rough=0.9),
        'Plinth': material('HofPlinth', image=plain_texture('tex_hof_plinth', (0.55, 0.57, 0.60), 75, streak=0.12), rough=0.85),
        'Cladding': material('HofCladding', image=cladding_texture('tex_hof_cladding'), rough=0.6),
        'Slate': material('HofSlate', image=slate_texture('tex_hof_slate', 76), rough=0.6),
        'Zinc': material('HofZinc', (0.50, 0.52, 0.54), 0.45, 0.6),
        'Steel': material('HofSteel', (0.64, 0.66, 0.68), 0.5, 0.15),  # galvanised (hardly metallic: the game has no reflections)
        'SteelDark': material('HofSteelDark', (0.17, 0.18, 0.19), 0.5, 0.4),
        'Red': material('HofRed', (0.72, 0.10, 0.10), 0.45),
        'Stone': material('HofStone', image=plain_texture('tex_hof_stone', (0.66, 0.66, 0.64), 77, grain=0.03), rough=0.8),
        'Granite': material('HofGranite', image=plain_texture('tex_hof_granite', (0.60, 0.60, 0.60), 78, grain=0.06, cells=32), rough=0.6),
        'Paving': material('HofPaving', image=brick_texture('tex_hof_paving', [(0.36, 0.37, 0.39), (0.40, 0.41, 0.43), (0.33, 0.34, 0.36),
                                                                             (0.38, 0.39, 0.40)], (0.24, 0.25, 0.26), 79, nx=3, ny=5), rough=0.9),
        'Asphalt': material('HofAsphalt', image=plain_texture('tex_hof_asphalt', (0.20, 0.20, 0.21), 80, grain=0.035, cells=5), rough=0.95),
        'Soil': material('HofSoil', image=plain_texture('tex_hof_soil', (0.20, 0.16, 0.12), 81, grain=0.04), rough=1.0),
        'Leaves': material('HofLeaves', image=foliage_texture('tex_hof_leaves', 82), rough=0.9),
        'LeavesLight': material('HofLeavesLight', image=foliage_texture('tex_hof_leaves_light', 83, (0.30, 0.42, 0.14)), rough=0.9),
        'Bark': material('HofBark', (0.34, 0.30, 0.26), 0.9),
        'Rock': material('HofRock', image=plain_texture('tex_hof_rock', (0.34, 0.35, 0.37), 84, grain=0.04, cells=5), rough=0.9),
        'RoofDark': material('HofRoofDark', (0.24, 0.24, 0.25), 0.9),
        'Door': material('HofDoor', (0.93, 0.93, 0.91), 0.5),
        'DoorDark': material('HofDoorDark', (0.20, 0.21, 0.22), 0.5, 0.3),
        'GlassDark': material('HofGlassDark', (0.08, 0.10, 0.12), 0.15),
        'Glass': see_through(material('HofGlass', (0.55, 0.62, 0.64), 0.05), 0.28),
        'Grille': material('HofGrille', image=grille_texture('tex_hof_grille'), rough=0.5, metal=0.4),
        'SignErft': material('HofSignErft', image=text_texture('tex_hof_erfthaus', 'ERFTHAUS', 512, 64, (0.30, 0.31, 0.33), (0.62, 0.63, 0.64)), rough=0.5),
        'SignKieser': material('HofSignKieser', image=text_texture('tex_hof_kieser', 'KIESER', 512, 96, (0.97, 0.97, 0.97), (0.16, 0.17, 0.19), 0.24), rough=0.4),
        'SignOpen': material('HofSignOpen', image=text_texture('tex_hof_open', 'OPEN', 256, 64, (0.97, 0.97, 0.97), (0.10, 0.10, 0.11), 0.22), rough=0.4),
        'Poster1': material('HofPoster1', image=poster_texture('tex_hof_poster1', 1, (0.72, 0.80, 0.90), (0.95, 0.95, 0.97)), rough=0.5),
        'Poster2': material('HofPoster2', image=poster_texture('tex_hof_poster2', 2, (0.95, 0.95, 0.93), (0.75, 0.10, 0.10)), rough=0.5),
        'Poster3': material('HofPoster3', image=poster_texture('tex_hof_poster3', 3, (0.93, 0.93, 0.92), (0.15, 0.15, 0.16)), rough=0.5),
        'Lamp': material('HofLamp', (1.0, 0.95, 0.85), 0.4, emit_image=_img('tex_hof_lamp', np.ones((8, 8, 3), np.float32) * np.array((1.0, 0.86, 0.62), np.float32))),
    }
    for style, s in WIN.items():
        for v in range(s['n']):
            kw = dict(cols=s['cols'], rows=s['rows'], arch=s['arch'], frame=s['frame'], curtains=s.get('curtains', False), seed=v,
                      w=s['w'], h=s['h'], glass=s.get('glass', (0.08, 0.10, 0.12)), bar=0.022 if s['cols'] > 3 else 0.03,
                      outer=0.035 if s['cols'] > 3 else 0.07)
            day = grid_window_texture(f'tex_hof_{style}{v}', **kw)
            lit = grid_window_texture(f'tex_hof_{style}{v}_lit', lit=True, **kw)
            clip = s['arch'] > 0
            m[f'{style}{v}'] = material(f'Hof{style}{v}', image=day, rough=0.2, clip=clip)
            m[f'{style}{v}Lit'] = material(f'Hof{style}{v}Lit', image=day, emit_image=lit, rough=0.2, clip=clip)
    return m


def win_mat(style, p_lit=0.25):
    return f"{style}{RNG.integers(0, WIN[style]['n'])}{'Lit' if RNG.random() < p_lit else ''}"


# ---------------------------------------------------------------- facade parts

def window(B, w, u, z0, width, height, style, p_lit=0.25, sill='Stone', d=0.03):
    """Window centred at u with its sill at z0 (a flat pane just in front of the wall)."""
    panel(B, w, u - width / 2, u + width / 2, z0, z0 + height, win_mat(style, p_lit), d, UV01)
    if sill:
        obox(B, w, u - width / 2 - 0.08, u + width / 2 + 0.08, 0.0, 0.14, z0 - 0.1, z0, sill)


def lintel(B, w, u, z, width, mat='Plinth', h=0.32):
    """The grey band over a window of the white building."""
    obox(B, w, u - width / 2 - 0.12, u + width / 2 + 0.12, 0.0, 0.07, z, z + h, mat)


def corbel(B, w, u0, u1, z, mat='Klinker', h=0.5, d=0.0):
    """Brick frieze under an eave: a projecting course on small corbels."""
    obox(B, w, u0, u1, d, d + 0.14, z + h - 0.16, z + h, mat)
    n = max(1, int((u1 - u0) / 0.5))
    for k in range(n):
        u = u0 + (u1 - u0) * (k + 0.5) / n
        obox(B, w, u - 0.09, u + 0.09, d, d + 0.09, z, z + h - 0.16, mat)


def canopy(B, w, u, z, width=1.5, depth=1.0):
    """Glass canopy on two steel stays over a door."""
    B.face([w.p(u - width / 2, 0.05, z), w.p(u + width / 2, 0.05, z), w.p(u + width / 2, depth, z - 0.12), w.p(u - width / 2, depth, z - 0.12)],
           'Glass', out=(0, 0, 1))
    for s in (-1, 1):
        beam(B, w.p(u + s * width / 2, 0.05, z), w.p(u + s * width / 2, depth, z - 0.12), 0.04, 0.05, 'SteelDark')
        beam(B, w.p(u + s * width / 2, 0.05, z + 0.55), w.p(u + s * width / 2, depth, z - 0.1), 0.02, 0.02, 'SteelDark')
    beam(B, w.p(u - width / 2, depth, z - 0.12), w.p(u + width / 2, depth, z - 0.12), 0.04, 0.05, 'SteelDark')


def railing(B, pts, z, mat_top='Red', height=0.95, posts=1.3, ball=None):
    """Steel railing along a polyline (2D) standing on z: posts, three thin rails and a thick top rail."""
    pts = [V(p) for p in pts]
    run = 0.0
    last = None
    for a, b in zip(pts, pts[1:]):
        for hgt in (0.3, 0.52, 0.74):
            beam(B, (a.x, a.y, z + hgt), (b.x, b.y, z + hgt), 0.025, 0.025, 'Steel')
        beam(B, (a.x, a.y, z + height), (b.x, b.y, z + height), 0.075, 0.075, mat_top)
        ln = (b - a).length
        while run <= ln:
            q = a + (b - a) * (run / ln)
            if last is None or (q - last).length > posts * 0.6:
                beam(B, (q.x, q.y, z), (q.x, q.y, z + height), 0.05, 0.05, 'Steel')
                last = q
            run += posts
        run -= ln
    e = pts[-1]
    beam(B, (e.x, e.y, z), (e.x, e.y, z + height), 0.05, 0.05, 'Steel')
    for i in ball or []:
        blob(B, (pts[i].x, pts[i].y, z + height), 0.11, mat_top, RNG, squash=1.0, rough=0.0, rings=4, seg=8)


def steps(B, w, u0, u1, d0, n, rise, mat='Steel', C=None):
    """n steps up along the wall from u0 (bottom) to u1 (the landing's edge), d0…d0+1.0 out from it; C: collision."""
    run = (u1 - u0) / n
    for k in range(n):
        ua, ub = u0 + run * k, u0 + run * (k + 1)
        z = rise * (k + 1)
        obox(B, w, min(ua, ub), max(ua, ub), d0, d0 + 1.0, z - 0.05, z, mat)
        if C:
            obox(C, w, min(ua, ub), max(ua, ub), d0, d0 + 1.0, 0.0, z, 'x')


def wing_face(B, w, u0, u1, axes, door=None, C=None, widths=None):
    """Courtyard face of a wing between u0 and u1: grey plinth, a cellar window, arched windows on the four floors,
    the cornice; door = (u, side): the house door with canopy, landing and steel stairs running down towards side."""
    obox(B, w, u0, u1, 0.0, 0.05, 0.0, 1.15, 'Plinth')
    for i, u in enumerate(axes):
        wd = (widths or {}).get(i, 1.15)
        for k, z in enumerate(WING_SILLS):
            if door and k == 0 and abs(u - door[0]) < 0.1:
                continue
            window(B, w, u, z, wd, 2.05, 'WinFlat')
        if not door or abs(u - door[0]) > 0.1:
            panel(B, w, u - 0.4, u + 0.4, 0.3, 0.85, 'GlassDark', 0.06)
    corbel(B, w, u0, u1, Z_WING_EAVE - 0.55)
    if door:
        u, side = door
        zl = 1.45  # the landing: the raised ground floor
        panel(B, w, u - 0.5, u + 0.5, zl, zl + 2.15, 'Door', 0.03)
        panel(B, w, u - 0.36, u + 0.36, zl + 1.0, zl + 2.0, 'GlassDark', 0.04)
        panel(B, w, u - 0.5, u + 0.5, zl + 2.2, zl + 2.8, win_mat('WinDormer', 0.4), 0.03, UV01)
        canopy(B, w, u, zl + 2.95)
        obox(B, w, u - 0.7, u + 0.7, 0.05, 1.05, zl - 0.06, zl, 'Steel')
        steps(B, w, u + side * (0.7 + 2.1), u + side * 0.7, 0.05, 7, zl / 8, C=C)
        for s in (0.05, 1.05):
            rail = [w.p(u + side * 2.8, s), w.p(u + side * 0.7, s), w.p(u - side * 0.7, s)]
            for a, b, za, zb in ((rail[0], rail[1], 0.18, zl), (rail[1], rail[2], zl, zl)):
                if s > 0.5 or a is rail[0]:
                    beam(B, (*a, za + 0.95), (*b, zb + 0.95), 0.04, 0.04, 'Steel')
                    beam(B, (*a, za + 0.5), (*b, zb + 0.5), 0.02, 0.02, 'Steel')
            for q, zq in ((rail[0], 0.18), (rail[1], zl), (rail[2], zl)):
                if s > 0.5 or q is rail[0]:
                    beam(B, (*q, zq - (0.18 if q is rail[0] else 0)), (*q, zq + 0.95), 0.04, 0.04, 'Steel')
        beam(B, w.p(u - side * 0.7, 0.05, zl + 0.95), w.p(u - side * 0.7, 1.05, zl + 0.95), 0.04, 0.04, 'Steel')
        obox(B, w, u - side * 0.95 - 0.16, u - side * 0.95 + 0.16, 0.02, 0.14, zl + 1.0, zl + 1.4, 'SteelDark')  # letter box
        if C:
            obox(C, w, u - 0.7, u + 0.7, 0.05, 1.05, 0.0, zl, 'x')


def mansard(B, w, u0, u1, n_dormers, end0=True, end1=True):
    """Slate mansard over the face from the eave up to the flat roof, with dormers."""
    lo, hi = (0.12, Z_WING_EAVE), (-MANSARD_IN, Z_WING_TOP)
    B.face([w.p(u0, lo[0], lo[1]), w.p(u1, lo[0], lo[1]), w.p(u1, hi[0], hi[1]), w.p(u0, hi[0], hi[1])], 'Slate', out=w.out(0.4))
    for u, on in ((u0, end0), (u1, end1)):
        if on:
            B.face([w.p(u, lo[0], lo[1]), w.p(u, hi[0], hi[1]), w.p(u, hi[0], lo[1])], 'Klinker', out=tuple(w.t * (-1 if u == u0 else 1)) + (0,))
    obox(B, w, u0, u1, hi[0] - 0.15, hi[0] + 0.1, hi[1], hi[1] + 0.12, 'Zinc')
    for k in range(n_dormers):
        u = u0 + (u1 - u0) * (k + 0.5) / n_dormers
        z0, z1, hw = Z_WING_EAVE + 0.55, Z_WING_EAVE + 2.35, 0.75
        obox(B, w, u - hw, u + hw, -MANSARD_IN, -0.1, z0, z1, 'Zinc', top='Zinc')
        panel(B, w, u - hw + 0.1, u + hw - 0.1, z0 + 0.12, z1 - 0.12, win_mat('WinDormer', 0.3), -0.08, UV01)
        obox(B, w, u - hw - 0.08, u + hw + 0.08, -MANSARD_IN, -0.02, z1, z1 + 0.09, 'Zinc')


def wings(B, C):
    # --- north wing: its south face (west → east), the stub's south face beside the front house
    for poly in (WING_N, WING_N_E):
        prism(B, poly, SINK, Z_WING_EAVE, 'Klinker', top='RoofDark')
        prism(C, poly, SINK, Z_WING_TOP, 'x', top='x')
    w = Wall(WING_N[4], WING_N[3])
    wing_face(B, w, 0, w.L, [1.5, 4.0, 6.8, 9.6, 12.3], door=(4.0, 1), C=C, widths={0: 0.9})
    mansard(B, w, 0, w.L, 3)
    att = [w.p(0, -MANSARD_IN), w.p(w.L, -MANSARD_IN), WING_N[1], WING_N[0]]
    prism(B, att, Z_WING_EAVE, Z_WING_TOP, 'Klinker', top='RoofDark')
    ws = Wall(WING_N_E[3], WING_N_E[2])
    wing_face(B, ws, 0, ws.L, [1.75])
    mansard(B, ws, 0, ws.L, 1, end1=False)
    prism(B, [ws.p(0, -MANSARD_IN), ws.p(ws.L, -MANSARD_IN), WING_N_E[1], WING_N_E[0]], Z_WING_EAVE, Z_WING_TOP, 'Klinker', top='RoofDark')
    wr = Wall(WING_N[3], WING_N_E[3])  # the short return between the two faces
    obox(B, wr, 0, wr.L, 0.0, 0.05, 0.0, 1.15, 'Plinth')
    # roof terrace railing on the flat roof
    for a, b in ((w.p(0.3, -MANSARD_IN - 0.3), w.p(w.L - 0.3, -MANSARD_IN - 0.3)),):
        beam(B, (*a, Z_WING_TOP + 0.9), (*b, Z_WING_TOP + 0.9), 0.04, 0.04, 'Steel')
        for k in range(8):
            q = V(a) + (V(b) - V(a)) * (k / 7)
            beam(B, (q.x, q.y, Z_WING_TOP), (q.x, q.y, Z_WING_TOP + 0.9), 0.03, 0.03, 'Steel')
        B.face([(*a, Z_WING_TOP + 0.1), (*b, Z_WING_TOP + 0.1), (*b, Z_WING_TOP + 0.85), (*a, Z_WING_TOP + 0.85)], 'Glass', out=w.out())

    # --- south wing: its north face (east → west), blank gable in the west
    for poly in (WING_S, WING_S_E):
        prism(B, poly, SINK, Z_WING_EAVE, 'Klinker', top='RoofDark')
        prism(C, poly, SINK, Z_WING_TOP, 'x', top='x')
    w = Wall(WING_S[0], WING_S[4])
    wing_face(B, w, 0, w.L, [1.5, 4.3, 7.4], door=(4.3, -1), C=C)
    mansard(B, w, 0, w.L, 3, end1=False)
    prism(B, [WING_S[1], WING_S[2], WING_S[3], w.p(w.L, -MANSARD_IN), w.p(0, -MANSARD_IN)], Z_WING_EAVE, Z_WING_TOP, 'Klinker', top='RoofDark')
    g = Wall(WING_S[4], WING_S[3])  # the gable: blank but for one ground-floor window
    prism(B, [g.p(0, -0.02), g.p(g.L, -0.02), g.p(g.L, -0.3), g.p(0, -0.3)], Z_WING_EAVE, Z_WING_TOP + 0.25, 'Klinker', top='Zinc')
    obox(B, g, 0, g.L, 0.0, 0.05, 0.0, 1.15, 'Plinth')
    window(B, g, 1.7, WING_SILLS[0], 1.15, 2.05, 'WinFlat')
    panel(B, g, 3.6, 4.4, 0.25, 0.8, 'GlassDark', 0.06)
    ws = Wall(WING_S_E[0], WING_S_E[3])  # the stub beside the front house: barred cellar door, windows above
    wing_face(B, ws, 0, ws.L, [1.7])
    mansard(B, ws, 0, ws.L, 1, end0=False)
    prism(B, [WING_S_E[1], WING_S_E[2], ws.p(ws.L, -MANSARD_IN), ws.p(0, -MANSARD_IN)], Z_WING_EAVE, Z_WING_TOP, 'Klinker', top='RoofDark')
    wr = Wall(WING_S_E[3], WING_S[0])
    obox(B, wr, 0, wr.L, 0.0, 0.05, 0.0, 1.15, 'Plinth')
    # flood light at the wing's corner
    c = w.p(w.L - 0.1, 0.25, 6.2)
    beam(B, w.p(w.L - 0.1, 0.0, 6.2), c, 0.03, 0.03, 'SteelDark')
    obox(B, w, w.L - 0.28, w.L + 0.08, 0.2, 0.36, 6.1, 6.32, 'SteelDark')


def tower(B, C):
    prism(B, TOWER, SINK, Z_TOWER, 'Klinker', top='RoofDark')
    prism(C, TOWER, SINK, Z_TOWER, 'x', top='x')
    faces = [Wall(TOWER[5], TOWER[4]), Wall(TOWER[4], TOWER[3]), Wall(TOWER[3], TOWER[2]), Wall(TOWER[2], TOWER[1]), Wall(TOWER[1], TOWER[0])]
    for f in faces:
        corbel(B, f, 0, f.L, Z_TOWER - 1.5, h=0.9)
        obox(B, f, -0.05, f.L + 0.05, -0.05, 0.2, Z_TOWER, Z_TOWER + 0.14, 'Zinc')
    front = faces[2]
    for z in (4.3, 8.9, 13.3):  # the stairwell's steel windows, each over a recessed brick field
        window(B, front, front.L / 2, z, 2.3, 2.5, 'WinSteelRect', 0.45)
        obox(B, front, front.L / 2 - 1.3, front.L / 2 + 1.3, 0.0, 0.05, z - 1.3, z - 0.2, 'KlinkerDark')
    window(B, faces[0], faces[0].L / 2 + 0.2, 5.4, 1.5, 2.6, 'WinSteelTall', 0.4)
    window(B, faces[0], faces[0].L / 2 + 0.2, 9.9, 1.5, 2.6, 'WinSteelTall', 0.4)
    panel(B, front, front.L / 2 - 1.0, front.L / 2 + 1.0, 0.25, 2.9, 'GlassDark', 0.03)  # the door behind the porch

    # --- the glass porch on its granite step, in front of the tower's face
    c0, c1, depth, ch = 0.0, front.L + 0.5, 3.1, 0.8
    step_outline = [front.p(c0 - 0.6, 0.0), front.p(c0 - 0.6, depth - ch + 0.5), front.p(c0 - 0.6 + ch, depth + 0.5),
                    front.p(c1 + 0.6 - ch, depth + 0.5), front.p(c1 + 0.6, depth - ch + 0.5), front.p(c1 + 0.6, 0.0)]
    prism(B, step_outline, SINK, 0.22, 'Granite', top='Granite')
    prism(C, step_outline, SINK, 0.22, 'x', top='x')
    ring = [front.p(c0, 0.0), front.p(c0, depth - ch), front.p(c0 + ch, depth), front.p(c1 - ch, depth), front.p(c1, depth - ch), front.p(c1, 0.0)]
    z0, z1 = 0.22, 3.3
    for i, (a, b) in enumerate(zip(ring, ring[1:])):
        a, b = V(a), V(b)
        n = max(1, round((b - a).length / 1.1))
        out = tuple((a + b) / 2 - V(front.p((c0 + c1) / 2, depth / 2))) + (0,)
        door = i == 2  # the front: two open bays as the doorway
        for k in range(n):
            p, q = a + (b - a) * (k / n), a + (b - a) * ((k + 1) / n)
            if not (door and k in (1, 2)):
                B.face([(p.x, p.y, z0), (q.x, q.y, z0), (q.x, q.y, z1), (p.x, p.y, z1)], 'Glass', out=out)
            elif k == 1:
                B.face([(p.x, p.y, 2.45), (q.x, q.y, 2.45), (q.x, q.y, z1), (p.x, p.y, z1)], 'SignOpen', out=out, uvs=UV01)
            else:
                B.face([(p.x, p.y, 2.45), (q.x, q.y, 2.45), (q.x, q.y, z1), (p.x, p.y, z1)], 'Glass', out=out)
            beam(B, (p.x, p.y, z0), (p.x, p.y, z1), 0.05, 0.05, 'Steel')
        beam(B, (b.x, b.y, z0), (b.x, b.y, z1), 0.05, 0.05, 'Steel')
        for z in (z0 + 0.03, 2.45, z1 - 0.03):
            if not (door and z < 1):
                beam(B, (a.x, a.y, z), (b.x, b.y, z), 0.05, 0.05, 'Steel')
        if not door:
            prism(C, [tuple(a), tuple(b), tuple(b + V(out).to_2d().normalized() * -0.1), tuple(a + V(out).to_2d().normalized() * -0.1)], z0, z1, 'x')
    for p in ring[1:5]:  # the red perforated columns inside the corners
        q = V(p) + (V(front.p((c0 + c1) / 2, depth / 2)) - V(p)).normalized() * 0.22
        beam(B, (q.x, q.y, z0), (q.x, q.y, z1), 0.16, 0.16, 'Red')
    roof = [front.p(c0 - 0.15, 0.0), front.p(c0 - 0.15, depth - ch + 0.1), front.p(c0 + ch - 0.1, depth + 0.15),
            front.p(c1 - ch + 0.1, depth + 0.15), front.p(c1 + 0.15, depth - ch + 0.1), front.p(c1 + 0.15, 0.0)]
    prism(B, roof, z1, z1 + 0.2, 'SteelDark', top='RoofDark', bottom=True)
    prism(C, roof, z1, z1 + 0.2, 'x', top='x')
    # the bollard lamp in front of the step
    bc = front.p(c1 - 0.2, depth + 1.1)
    cyl(B, bc, 0.2, 0.0, 1.55, 'Steel')
    blob(B, (*bc, 1.55), 0.2, 'Steel', RNG, squash=0.8, rough=0.0, rings=4, seg=12, base=0.01)
    cyl(C, bc, 0.2, 0.0, 1.7, 'x', seg=6)


def lift(B, C):
    """White lift shaft north of the tower, with the sign frame at its foot."""
    w = Wall(A2, A1)  # the factory's face north of the tower, south → north
    u1, dep = 3.1, 2.7
    fp = [w.p(0, 0), w.p(0, dep), w.p(u1, dep), w.p(u1, 0)]
    prism(B, fp, SINK, Z_LIFT, 'Cladding', top='Zinc')
    prism(C, fp, SINK, Z_LIFT, 'x', top='x')
    east = Wall(w.p(0, dep), w.p(u1, dep))
    obox(B, east, -0.06, u1 + 0.06, -0.3, 0.1, Z_LIFT, Z_LIFT + 0.15, 'Zinc')
    panel(B, east, u1 / 2 - 0.25, u1 / 2 + 0.25, Z_LIFT - 1.6, Z_LIFT - 1.0, 'GlassDark', 0.02)
    obox(B, east, 0, u1, 0.0, 0.04, 0.0, 0.95, 'Plinth')
    # sign frame: header band, the house numbers' column, two posters
    obox(B, east, 0.05, u1 - 0.05, 0.0, 0.12, 0.95, 3.75, 'Zinc')
    panel(B, east, 0.1, u1 - 0.1, 3.3, 3.7, 'SignErft', 0.13, UV01)
    panel(B, east, 0.45, 1.7, 1.1, 3.2, 'Poster1', 0.13, UV01)
    panel(B, east, 1.78, u1 - 0.12, 1.1, 3.2, 'Poster2', 0.13, UV01)


def west_face(B, C, ramp_z):
    """The factory's east face (kept LOD2 building): KIESER entrance north of the lift, the part south of the tower."""
    # --- north of the lift: brick up to the glass roof's foot, the white building's wall above
    w = Wall(A2, A1, SKIN)
    n0 = 3.1
    panel(B, w, n0, w.L, 0.0, 14.2, 'Klinker', 0.0)
    panel(B, w, n0, w.L, 14.2, Z_WEST, 'WhiteBrick', 0.0)
    w2 = Wall(A1, A0, SKIN)
    panel(B, w2, 0, w2.L, 0.0, 14.2, 'Klinker', 0.0)
    panel(B, w2, 0, w2.L, 14.2, Z_WEST, 'WhiteBrick', 0.0)
    um = (n0 + w.L) / 2 + 1.1  # the bay's middle (it runs on round the kink into w2)
    wide = min(3.4, w.L + w2.L - n0 - 0.5)
    for z in IND_SILLS[:2]:
        window(B, w, um, z, min(wide, 2.6), 2.9, 'WinSteel', 0.4)
    corbel(B, w, n0, w.L, 13.3, h=0.8)
    panel(B, w, um - wide / 2, um + wide / 2, 0.1, 3.0, win_mat('WinShop', 0.9), 0.03, UV01)
    panel(B, w, um - wide / 2, um + wide / 2, 3.0, 3.75, 'SignKieser', 0.05, UV01)
    panel(B, w, um - wide / 2, um + wide / 2, 3.75, 4.5, win_mat('WinStrip', 0.9), 0.03, UV01)
    obox(B, w, um - wide / 2, um + wide / 2, 0.0, 0.1, 2.9, 3.0, 'SteelDark')

    # --- south of the tower: big arched steel windows; at the ramp's foot the garage gate
    w = Wall(A4, A3, SKIN)
    panel(B, w, 0, w.L, -2.6, Z_WEST, 'Klinker', 0.0)
    corbel(B, w, 0, w.L, Z_WEST - 1.0, h=0.8)
    panel(B, w, 0, w.L, -2.6, -0.6, 'KlinkerDark', 0.02)  # the damp red base down the ramp
    for z in IND_SILLS:
        window(B, w, 2.4, z, 2.7, 2.9, 'WinSteel', 0.4)
        window(B, w, w.L - 1.45, z, 1.3, 2.9, 'WinSteelTall', 0.4)
    window(B, w, 5.6, 0.9, 2.2, 3.0, 'WinSteel', 0.3)  # over the bike platform
    zg = ramp_z(*w.p(2.1, 0.5))  # the ramp at the gate
    panel(B, w, 0.5, 3.7, zg - 0.1, zg + 2.45, 'Grille', 0.04, [(0, 0), (1.6, 0), (1.6, 1.2), (0, 1.2)])
    panel(B, w, 0.5, 3.7, zg + 2.45, zg + 3.0, 'SteelDark', 0.05)
    window(B, w, 2.1, zg + 3.9, 2.7, 2.4, 'WinSteelRect', 0.4)


def white_building(B, C):
    """The white-painted building in the north: its body (plain brick away from the yard), the south face on the yard
    (west → east) and the small roof terrace at the top floor's east corner."""
    top = [WHITE_BIG[0], T1, T2, T3] + WHITE_BIG[3:]
    prism(B, WHITE_BIG, SINK, Z_TERR, 'Klinker', top='Stone')
    prism(B, top, Z_TERR, Z_WHITE, 'Klinker', top='RoofDark')
    prism(C, WHITE_BIG, SINK, Z_TERR, 'x', top='x')
    prism(C, top, Z_TERR, Z_WHITE, 'x', top='x')
    for poly in WHITE_REST:
        prism(B, poly, SINK, Z_WHITE, 'Klinker', top='RoofDark')
        prism(C, poly, SINK, Z_WHITE, 'x', top='x')
    # the sides away from the yard: rows of steel windows on the long outer walls
    for poly in [WHITE_BIG] + WHITE_REST:
        for a, b, _, _ in edges(ccw([V(q) for q in poly])):
            mid = (a + b) / 2
            if (b - a).length < 6 or not (mid.y > -1193.0 or mid.x < 240.0):
                continue
            f = Wall(tuple(a), tuple(b))
            n = int(f.L // 3.6)
            for k in range(n):
                for z in (1.6, 5.6, 9.6, 13.6):
                    window(B, f, f.L * (k + 0.5) / n, z, 2.2, 2.6, 'WinSteelRect', 0.3)

    w = Wall(A0, N1, SKIN)
    panel(B, w, 0, TERR_U, 0.0, Z_WHITE, 'WhiteBrick', 0.0)
    panel(B, w, TERR_U, w.L, 0.0, Z_TERR, 'WhiteBrick', 0.0)
    obox(B, w, 0, w.L, 0.0, 0.015, 0.0, 0.9, 'Plinth')  # (behind the glazing and the door, which stand 3 cm out)
    q = Wall(N1, N2, SKIN)
    panel(B, q, 0, q.L, 0.0, Z_TERR, 'WhiteBrick', 0.0)
    obox(B, q, 0, q.L, 0.0, 0.015, 0.0, 0.9, 'Plinth')
    st = Wall(N2, N3, SKIN)  # the brick stub between the white building and the north wing
    panel(B, st, 0, st.L, 0.0, Z_WHITE, 'Klinker', 0.0)
    # ground floor: the big steel glazing, then the door bay
    panel(B, w, 0.6, 7.2, 0.5, 4.7, win_mat('WinShop', 0.85), 0.03, [(0, 0), (1.3, 0), (1.3, 1), (0, 1)])
    lintel(B, w, 3.9, 4.7, 6.6)
    for z in (6.3, 10.3):  # two storeys of big many-paned windows
        for u, wd in ((2.2, 3.1), (5.8, 3.1)):
            window(B, w, u, z, wd, 2.9, 'WinSteelRect', 0.4, sill='Plinth')
            lintel(B, w, u, z + 2.9, wd)
    # the top floor: glazed from just above its floor almost up to the roof
    panel(B, w, 0.5, TERR_U - 0.35, Z_TERR + 0.5, Z_WHITE - 0.45, win_mat('WinShop', 0.4), 0.03, [(0, 0), (1.2, 0), (1.2, 1), (0, 1)])
    obox(B, w, 0.3, TERR_U - 0.15, 0.0, 0.1, Z_TERR + 0.36, Z_TERR + 0.5, 'Zinc')
    obox(B, w, 0.0, TERR_U, 0.0, 0.2, Z_WHITE - 0.12, Z_WHITE, 'Zinc')
    ud = 9.3  # the door bay
    panel(B, w, ud - 0.75, ud + 0.75, 0.05, 2.7, 'DoorDark', 0.03)
    panel(B, w, ud - 0.6, ud + 0.6, 0.3, 2.55, 'GlassDark', 0.04)
    canopy(B, w, ud, 3.0, 1.9, 1.1)
    for z in (3.4, 7.2, 11.0):
        window(B, w, ud, z, 1.9, 2.7, 'WinSteelRect', 0.4, sill='Plinth')
        lintel(B, w, ud, z + 2.7, 1.9)
    obox(B, w, ud - 1.6, ud - 1.25, 0.0, 0.12, 0.95, 1.4, 'SteelDark')  # letter box
    cyl(B, q.p(q.L - 0.15, 0.1), 0.06, 0.0, Z_TERR, 'Zinc', seg=8)  # downpipe at the corner to the brick stub

    # the roof terrace: white walls of the top floor round it with a glazed door, a glass balustrade along the edge
    wa, wb = Wall(T3, T2, 0.02), Wall(T2, T1, 0.02)
    for f in (wa, wb):
        panel(B, f, 0, f.L, Z_TERR, Z_WHITE, 'WhiteBrick', 0.0)
        obox(B, f, 0, f.L, 0.0, 0.2, Z_WHITE - 0.12, Z_WHITE, 'Zinc')
    window(B, wb, wb.L / 2, Z_TERR + 0.15, 2.6, 3.4, 'WinSteelRect', 0.5, sill=None)
    window(B, wa, wa.L / 2, Z_TERR + 0.9, 1.5, 2.6, 'WinSteelRect', 0.4, sill='Plinth')
    rail = [w.p(TERR_U, -0.2), w.p(w.L, -0.2), q.p(q.L - 0.1, -0.2)]
    for a, b in zip(rail, rail[1:]):
        B.face([(*a, Z_TERR + 0.08), (*b, Z_TERR + 0.08), (*b, Z_TERR + 1.0), (*a, Z_TERR + 1.0)], 'Glass', out=w.out())
        beam(B, (*a, Z_TERR + 1.02), (*b, Z_TERR + 1.02), 0.05, 0.04, 'Steel')
        for p in (a, b):
            beam(B, (*p, Z_TERR), (*p, Z_TERR + 1.02), 0.04, 0.04, 'Steel')
        prism(C, [a, b, (b[0], b[1] + 0.1), (a[0], a[1] + 0.1)], Z_TERR, Z_TERR + 1.0, 'x')


def south_face(B, ramp_z):
    """The southern building's north face over the ramp (kept LOD2 building), east → west, its blank east wall and
    the low white shed in front of that."""
    w = Wall(Y0, A4, SKIN)
    panel(B, w, 0, w.L, -2.6, 13.6, 'Klinker', 0.0)
    panel(B, w, 0, w.L, -2.6, -0.5, 'KlinkerDark', 0.02)
    corbel(B, w, 0, w.L, 13.0, h=0.7)
    panel(B, w, 0, w.L, 13.7, Z_SOUTH, 'Render', 0.0)
    obox(B, w, 0, w.L, 0.0, 0.18, Z_SOUTH - 0.1, Z_SOUTH, 'Zinc')
    panel(B, w, 0.6, 2.2, 14.3, 17.6, win_mat('WinSteelTall', 0.4), 0.03, UV01)
    panel(B, w, 3.4, 9.6, 15.0, 17.3, win_mat('WinStrip', 0.4), 0.03, UV01)
    for z in (5.0, 9.3):
        window(B, w, 1.5, z, 1.7, 3.1, 'WinSteelTall', 0.4)  # the east bay: tall narrow windows
        window(B, w, 5.9, z, 2.5, 2.8, 'WinSteel', 0.4)
    # ground: tall glazed door with a canopy on the east platform, an arched window low over the ramp
    panel(B, w, 0.65, 2.35, 0.05, 3.9, win_mat('WinSteelTall', 0.5), 0.03, UV01)
    canopy(B, w, 1.5, 4.15, 2.2, 0.9)
    zr = ramp_z(*w.p(5.9, 0.5))
    window(B, w, 5.9, zr + 1.0, 2.0, 2.2, 'WinSteel', 0.2)
    cyl(B, w.p(w.L - 0.25, 0.1), 0.06, ramp_z(*w.p(w.L - 0.25, 0.3)), 13.6, 'Zinc', seg=8)

    e = Wall(YSO_E, Y0, SKIN)  # blank rendered wall above the shed
    panel(B, e, 0, e.L, Z_SHED, Z_SOUTH, 'Render', 0.0)
    for a, b in ((U2, U3), (U1, U2), (WING_S[3], U1)):  # the shed's white walls
        s = Wall(a, b, SKIN)
        panel(B, s, 0, s.L, 0.0, Z_SHED, 'WhiteBrick', 0.0)
        obox(B, s, 0, s.L, 0.0, 0.03, 0.0, 0.7, 'Plinth')
        obox(B, s, 0, s.L, 0.0, 0.1, Z_SHED - 0.08, Z_SHED, 'Zinc')
    s = Wall(WING_S[3], U1, SKIN)  # its north face rises to 6.1 m at the wing (the roof falls to the west); the bin store behind a mesh screen in it
    B.face([s.p(0, 0, Z_SHED), s.p(s.L, 0, Z_SHED), s.p(0.6, 0, 6.15), s.p(0, 0, 6.15)], 'WhiteBrick', out=s.out())
    panel(B, s, 0.4, s.L - 0.4, 0.1, 2.1, 'Grille', 0.05, [(0, 0), (1.5, 0), (1.5, 1), (0, 1)])


# ---------------------------------------------------------------- the ground

def ramp_frame():
    """Frame at the yard's south-west corner: u east along the southern building, v north."""
    a, t, n = wall_frame(A4, Y0)
    return a, t, -n  # (wall_frame's normal points south here)


def ground(B, C, CUT):
    o, t, n = ramp_frame()

    def P(u, v):
        q = o + t * u + n * v
        return (q.x, q.y)

    ce, re, cn, rn = (9.9, 0.0), 3.2, (5.6, 7.4), 3.0
    arc_e = [P(*p) for p in arc(ce, re, math.pi, math.pi / 2, 9)]  # round the east platform: (6.7, 0) → (9.9, 3.2)
    arc_n = [P(*p) for p in arc(cn, rn, 0.0, -math.pi / 2, 9)]  # round the north platform: (8.6, 7.4) → (5.6, 4.4)
    mouth_a, mouth_b = V(arc_e[-1]), V(arc_n[0])
    md = (mouth_b - mouth_a).normalized()
    mn = V((md.y, -md.x))
    if mn.dot(V(P(0, 2)) - mouth_a) < 0:
        mn = -mn

    def ramp_z(x, y):
        """Height of the ramp's plane at (x, y): 0 along its mouth, falling towards the gate."""
        return -RAMP_SLOPE * max(0.0, (V((x, y)) - mouth_a).dot(mn))

    ramp = [P(0, 0)] + arc_e + arc_n + [P(0, 4.4)]
    for T in (B, C):
        fill(T, ramp, ramp_z, 'Asphalt' if T is B else 'x')
    # the terrain cut reaches well beyond the ramp (under the platforms and the walls' feet) and a little deeper: on its
    # 1 m grid the terrain would otherwise rise towards the yard's level inside the ramp, along the curved walls
    for i in range(-2, 11):
        for j in range(-2, 7):
            q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]
            CUT.face([(x, y, min(0.0, ramp_z(x, y) - 0.25) if ramp_z(x, y) < -0.01 else 0.0) for x, y in q], 'x', out=(0, 0, 1))
    # the yard: everything else at z 0 (the tower and the lift stand on it)
    wn, ws = Wall(WING_N[4], WING_N[3]), Wall(WING_S[0], WING_S[4])
    yard = ([A0, A1, A2] + TOWER[1:] + [P(0, 4.4)] + arc_n[::-1] + arc_e[::-1] + [P(Wall(A4, Y0).L, 0), U2, U1, WING_S[3], WING_S[4], WING_S[0],
            WING_S_E[3], WING_S_E[0], FRONT_N, WING_N_E[3], WING_N[3], WING_N[4], N2, N1])
    for T in (B, C, CUT):
        fill(T, yard, 0.0, 'Paving' if T is B else 'x')
    # a dark kerb line where the paving meets the asphalt
    beam(B, (*mouth_a, 0.0), (*mouth_b, 0.0), 0.16, 0.03, 'Granite')

    # --- the two curved retaining walls with their railings
    def retaining(line, inside, ball):
        """Brick wall along `line` (yard side = towards `inside`) from the ramp up to a parapet, stone cap, railing."""
        top, th = 0.5, 0.32
        inner = []
        for i, p in enumerate(line):
            a, b = V(line[max(0, i - 1)]), V(line[min(len(line) - 1, i + 1)])
            d = (b - a).normalized()
            nn = V((-d.y, d.x))
            if nn.dot(V(inside) - V(p)) < 0:
                nn = -nn
            inner.append(V(p) + nn * th)
        for i in range(len(line) - 1):
            a, b, ai, bi = V(line[i]), V(line[i + 1]), inner[i], inner[i + 1]
            za, zb = ramp_z(*a) - 0.1, ramp_z(*b) - 0.1
            out = tuple((a + b) / 2 - (ai + bi) / 2) + (0,)
            B.face([(a.x, a.y, za), (b.x, b.y, zb), (b.x, b.y, top), (a.x, a.y, top)], 'Klinker', out=out)
            B.face([(ai.x, ai.y, 0.0), (bi.x, bi.y, 0.0), (bi.x, bi.y, top), (ai.x, ai.y, top)], 'Klinker', out=tuple(-V(out)))
            cap = [a + (a - ai) * 0.12, b + (b - bi) * 0.12, bi + (bi - b) * 0.12, ai + (ai - a) * 0.12]
            prism(B, [tuple(q) for q in cap], top, top + 0.07, 'Stone', top='Stone', bottom=True)
            prism(C, [tuple(a), tuple(b), tuple(bi), tuple(ai)], za, top + 0.07, 'x', top='x')
        for q, qi in ((V(line[0]), inner[0]), (V(line[-1]), inner[-1])):  # the wall's ends
            B.face([(q.x, q.y, ramp_z(*q) - 0.1), (qi.x, qi.y, ramp_z(*q) - 0.1), (qi.x, qi.y, top + 0.07), (q.x, q.y, top + 0.07)], 'Klinker')
        mid = [tuple((V(p) + q) / 2) for p, q in zip(line, inner)]
        railing(B, mid, top + 0.07, ball=ball)

    retaining([P(0, 4.4)] + arc_n[::-1], P(2, 7), ball=[-1])
    retaining(arc_e, P(9.9, 0.5), ball=[-1])
    return ramp_z, P


def planting(B, C, P):
    wn = Wall(WING_N[4], WING_N[3])
    ww = Wall(A0, N1)

    def bed(w, u0, u1, d0, d1):
        """Planting bed against wall w: a stone kerb round dark soil."""
        obox(B, w, u0, u1, d0, d1, 0.0, 0.16, 'Stone', top='Soil')
        obox(C, w, u0, u1, d0, d1, 0.0, 0.16, 'x')

    def shrub(p, r, mat='Leaves', h=0.75):
        blob(B, (p[0], p[1], 0.16 + r * h * 0.55), r, mat, RNG, squash=h, rough=0.3, rings=5, seg=8, base=0.6)

    def rock(p, r):
        blob(B, (p[0], p[1], r * 0.35), r, 'Rock', RNG, squash=0.75, rough=0.3, rings=4, seg=7, base=0.5)
        cyl(C, p, r * 0.8, 0.0, r * 0.7, 'x', seg=6)

    def bollard(p, h=0.95):
        cyl(B, p, 0.07, 0.0, h, 'SteelDark', seg=8)
        cyl(C, p, 0.09, 0.0, h, 'x', seg=6)

    # the bed in front of the north wing (east of its stairs), with the steel pergola
    bed(wn, 7.2, wn.L - 0.2, 0.1, 2.3)
    for u, d, r in ((8.0, 1.2, 0.75), (9.4, 0.9, 0.6), (10.6, 1.4, 0.85), (12.0, 1.0, 0.65), (12.9, 1.7, 0.5)):
        shrub(wn.p(u, d), r, 'LeavesLight' if r < 0.62 else 'Leaves')
    for u in (7.5, 10.2, 12.9):
        for d in (0.5, 2.0):
            beam(B, wn.p(u, d, 0.16), wn.p(u, d, 2.3), 0.06, 0.06, 'Steel')
        beam(B, wn.p(u, 0.5, 2.3), wn.p(u, 2.0, 2.3), 0.06, 0.06, 'Steel')
    for d in (0.5, 2.0):
        beam(B, wn.p(7.5, d, 2.3), wn.p(12.9, d, 2.3), 0.06, 0.06, 'Steel')
    rock(wn.p(7.0, 2.6), 0.45)
    rock(wn.p(wn.L - 0.4, 2.9), 0.5)
    for u in (8.2, 10.4, 12.6):
        bollard(wn.p(u, 2.6))

    # the bed in front of the white building's glazing
    bed(ww, 0.7, 7.4, 0.25, 3.0)
    for u, d, r in ((1.5, 1.4, 0.8), (2.9, 2.0, 0.65), (4.4, 1.2, 0.9), (5.8, 2.1, 0.7), (6.8, 1.0, 0.55)):
        shrub(ww.p(u, d), r, 'LeavesLight' if r < 0.68 else 'Leaves')
    rock(ww.p(6.9, 3.4), 0.5)
    bollard(ww.p(1.2, 3.3))
    bollard(ww.p(4.6, 3.3))
    beam(B, ww.p(5.4, 3.25, 0.55), ww.p(7.0, 3.25, 0.55), 0.14, 0.14, 'Red')  # the red bar at the bed's edge
    for u in (5.5, 6.9):
        beam(B, ww.p(u, 3.25, 0.0), ww.p(u, 3.25, 0.5), 0.07, 0.07, 'SteelDark')

    # boulders at the south wing's corners, the poster stand by its stairs
    ws = Wall(WING_S[0], WING_S[4])
    rock(ws.p(ws.L + 0.3, 0.9), 0.6)
    rock(ws.p(0.4, 1.9), 0.4)
    c = V(ws.p(1.6, 2.3))
    for s in (-1, 1):
        a, b = c + ws.t * -0.32, c + ws.t * 0.32
        off = ws.n * (0.18 * s)
        B.face([(a.x + off.x, a.y + off.y, 0.1), (b.x + off.x, b.y + off.y, 0.1), (b.x + off.x * 0.2, b.y + off.y * 0.2, 1.15),
                (a.x + off.x * 0.2, a.y + off.y * 0.2, 1.15)], 'Poster3', out=tuple(ws.n * s) + (0.2,), uvs=UV01)
    obox(B, ws, 1.25, 1.95, 2.05, 2.55, 0.0, 0.1, 'Plinth')
    obox(C, ws, 1.25, 1.95, 2.05, 2.55, 0.0, 1.1, 'x')
    # bike stands along the gable (steel hoops) and on the platform beside the tower
    g = Wall(WING_S[4], WING_S[3])
    for u in (1.2, 2.0, 2.8, 3.6, 4.4):
        for d0 in (0.5, 1.3):
            beam(B, g.p(u, d0, 0.0), g.p(u, d0, 0.8), 0.04, 0.04, 'Steel')
        beam(B, g.p(u, 0.5, 0.8), g.p(u, 1.3, 0.8), 0.04, 0.04, 'Steel')
    for u in (1.0, 1.9, 2.8):
        a, b = P(u, 5.3), P(u, 6.1)
        for q in (a, b):
            beam(B, (*q, 0.0), (*q, 0.8), 0.04, 0.04, 'Steel')
        beam(B, (*a, 0.8), (*b, 0.8), 0.04, 0.04, 'Steel')


# ---------------------------------------------------------------- build

def main():
    coll = reset_collection('ERFT_HAUS_HOF')
    B, C, CUT = Builder(make_materials()), Builder(), Builder()
    ramp_z, P = ground(B, C, CUT)
    wings(B, C)
    tower(B, C)
    lift(B, C)
    west_face(B, C, ramp_z)
    white_building(B, C)
    south_face(B, ramp_z)
    planting(B, C, P)
    ob = B.to_object(NAME, coll)
    col = C.to_object(f'{NAME}_col', coll)
    cut = CUT.to_object(f'{NAME}_cut', coll)
    for o in (col, cut):
        o.display_type = 'WIRE'
        o.hide_render = True
    return ob, col, cut


ob, col, cut = main()
print('STATS', {'tris': tris(ob), 'col_tris': tris(col), 'cut_tris': tris(cut)})
if globals().get('EXPORT', True):
    export_glb(os.path.join(HERE, f'{NAME}.glb'), [ob, col, cut])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'), copy=True)
