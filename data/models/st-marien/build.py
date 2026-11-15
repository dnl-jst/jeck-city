"""St. Marien (Köln-Nippes): procedural Blender model for the building override DENW37AL1000AEDb.

Run inside Blender (e.g. via the Blender MCP add-on):
    exec(open(PATH).read(), {'__file__': PATH})
It rebuilds the collection ST_MARIEN, saves st-marien.blend and exports st-marien.glb next to this file.

Conventions (see data/models/README.md): metres, Blender Z up (glTF export turns it into Y up),
Blender X = game x (east), Blender Y = -game z (north). The object sits in world coordinates:
location = church axis origin, rotation = church axis (8.91° north of east). Local axes:
u along the nave (east), v across (north), z up. Ground = z 0.
Footprint dimensions come from the LOD2 ground surface; the tower and details from photos.
"""
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from nnmodel import (V, Builder, _img, box, brick_texture, ccw, edges, export_glb, flat, line_x, material,  # noqa: E402
                     prism, rect_window, reset_collection, slate_texture, tris, wall_frame, on_wall)

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = 'st-marien'
ORIGIN = (-12.0, 132.0)
THETA = math.radians(8.91)

VC = -2.2  # nave centre line (v)
AP = 5.25  # half width of nave/transept = apothem of the polygonal ends
Z_WALL, Z_RIDGE = 15.0, 24.0
BAYS = [-18.85, -13.55, -8.2, -2.87, 2.5]  # buttress u positions
BAY_CENTRES = [-16.2, -10.9, -5.55, -0.2]
SINK = -0.3  # walls reach below ground so slopes never show a gap

# ---------------------------------------------------------------- textures










def stained_texture(name, seed, w=128, h=256, n=46):
    rng = np.random.default_rng(seed)
    pts = rng.uniform(0, 1, (n, 2)) * [w, h]
    pal = np.array([[0.12, 0.22, 0.65], [0.08, 0.15, 0.48], [0.65, 0.12, 0.10], [0.85, 0.62, 0.15],
                    [0.18, 0.48, 0.22], [0.75, 0.72, 0.58], [0.40, 0.16, 0.50], [0.20, 0.45, 0.70]], np.float32)
    cols = pal[rng.integers(0, len(pal), n)] * rng.uniform(0.75, 1.15, (n, 1))
    # muted: mostly grey-green cathedral glass with a hint of colour, seen from outside it reads dark
    grey = np.array([0.30, 0.33, 0.32], np.float32)
    cols = (0.3 * cols + 0.7 * grey) * rng.uniform(0.75, 1.1, (n, 1))
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt((xx[..., None] - pts[:, 0]) ** 2 + (yy[..., None] - pts[:, 1]) ** 2)
    o = np.sort(d, axis=2)
    img = cols[np.argmin(d, axis=2)]
    lead = (o[..., 1] - o[..., 0]) < 2.0
    border = (xx < 4) | (xx >= w - 4) | (yy < 4) | (yy >= h - 4)
    img[lead | border] = 0.05
    return _img(name, img)


# ---------------------------------------------------------------- materials



def make_materials():
    brick = brick_texture('tex_brick', [(0.44, 0.38, 0.31), (0.39, 0.33, 0.28), (0.49, 0.42, 0.34),
                                        (0.33, 0.29, 0.26), (0.53, 0.47, 0.38), (0.36, 0.33, 0.31)],
                          (0.56, 0.54, 0.50), 11, soot=0.12)
    red = brick_texture('tex_brick_red', [(0.57, 0.27, 0.20), (0.50, 0.23, 0.18), (0.63, 0.32, 0.23),
                                          (0.46, 0.22, 0.18), (0.59, 0.35, 0.28)], (0.62, 0.59, 0.55), 12)
    slate = slate_texture('tex_slate', 13)
    dark = brick_texture('tex_brick_dark', [(0.30, 0.22, 0.18), (0.26, 0.19, 0.16), (0.35, 0.26, 0.20),
                                            (0.22, 0.17, 0.15), (0.33, 0.27, 0.23)], (0.42, 0.40, 0.37), 15)
    glass = stained_texture('tex_stained', 14)
    return {
        'Brick': material('Brick', image=brick, rough=0.92),
        'BrickRed': material('BrickRed', image=red, rough=0.9),
        'Slate': material('Slate', image=slate, rough=0.6),
        'Stone': material('Stone', (0.74, 0.68, 0.56), 0.85),
        'Concrete': material('Concrete', (0.86, 0.85, 0.82), 0.9),
        'RoofFlat': material('RoofFlat', (0.62, 0.62, 0.60), 0.95),
        'StainedGlass': material('StainedGlass', image=glass, rough=0.15),
        'BrickDark': material('BrickDark', image=dark, rough=0.92),
        'Louver': material('Louver', (0.14, 0.12, 0.11), 0.9),
        'GlassModern': material('GlassModern', (0.10, 0.12, 0.14), 0.15),
        'Frame': material('Frame', (0.78, 0.78, 0.75), 0.6),
        'Shutter': material('Shutter', (0.82, 0.82, 0.78), 0.7),
        'Door': material('Door', (0.36, 0.23, 0.14), 0.7),
        'Gold': material('Gold', (0.80, 0.62, 0.25), 0.35, 1.0),
    }


# ---------------------------------------------------------------- geometry builder















def oct_end(cu, cv, axis_deg, a=AP):
    """Three faces of an octagon (apothem a) centred at (cu,cv) closing towards axis_deg; returns its 4 vertices."""
    r = a / math.cos(math.radians(22.5))
    return [(cu + r * math.cos(math.radians(axis_deg + d)), cv + r * math.sin(math.radians(axis_deg + d)))
            for d in (-67.5, -22.5, 22.5, 67.5)]




def roof(B, poly, ridge, zw, zr, apo, mat, overhang=0.35, wall_mat='Brick', soffit_mat=None):
    """Roof over a convex wall polygon whose faces rise from zw at the wall line to zr at distance apo.
    `ridge`: ridge end points (u,v). Edges through a ridge point become gables (walls, no overhang)."""
    poly = ccw([V(p).to_2d() for p in poly])
    ridge = [V(r) for r in ridge]
    slope = (zr - zw) / apo
    E = list(edges(poly))
    kind = []
    for a, b, t, n in E:
        d = [(r - a).dot(-n) for r in ridge]
        kind.append('gable' if any(abs(x) < 0.05 for x in d) else 'roof')
    off = [overhang if k == 'roof' else 0.0 for k in kind]
    # eave corner i = intersection of offset edges i-1 and i
    eave = []
    for i, (a, b, t, n) in enumerate(E):
        pa, ta, na = E[i - 1][0], E[i - 1][2], E[i - 1][3]
        eave.append(line_x(pa + na * off[i - 1], ta, a + n * off[i], t))
    ze = zw - slope * overhang
    for i, (a, b, t, n) in enumerate(E):
        j = (i + 1) % len(E)
        ea, eb = eave[i], eave[j]
        if kind[i] == 'gable':
            r = [r for r in ridge if abs((r - a).dot(-n)) < 0.05][0]
            B.face([(a.x, a.y, zw), (b.x, b.y, zw), (r.x, r.y, zr)], wall_mat, out=(n.x, n.y, 0))
            continue
        top = sorted([r for r in ridge if abs((r - a).dot(-n) - apo) < 0.05], key=lambda r: -(r - a).dot(t))
        za = zb = ze  # every eave point lies `overhang` outside this face's wall line
        pts = [(ea.x, ea.y, za), (eb.x, eb.y, zb)] + [(r.x, r.y, zr) for r in top]
        B.face(pts, mat, out=(n.x, n.y, 1))
        B.face([(a.x, a.y, ze), (b.x, b.y, ze), (eb.x, eb.y, zb), (ea.x, ea.y, za)],
               soffit_mat or wall_mat, out=(0, 0, -1))


def lean_to(B, u0, u1, v_low, v_high, z_low, z_high, mat, overhang=0.35, wall_mat='Brick'):
    """Mono-pitch roof along u, falling from v_high (z_high) to v_low (z_low) at the wall line; gable walls at both ends."""
    s = (z_high - z_low) / abs(v_high - v_low)
    sgn = 1 if v_low > v_high else -1
    ve = v_low + sgn * overhang
    ze = z_low - s * overhang
    B.face([(u0, ve, ze), (u1, ve, ze), (u1, v_high, z_high), (u0, v_high, z_high)], mat, out=(0, sgn, 1))
    B.face([(u0, v_low, ze), (u1, v_low, ze), (u1, ve, ze), (u0, ve, ze)], wall_mat, out=(0, 0, -1))
    for u, o in ((u0, -1), (u1, 1)):
        B.face([(u, v_low, z_low), (u, v_high, z_low), (u, v_high, z_high)], wall_mat, out=(o, 0, 0))






def lancet(B, a, b, s, w, z0, h, mat='StainedGlass', frame='Stone', mullion=False, d=0.05, seg=6):
    """Pointed (equilateral) arch window on the wall a→b (CCW poly edge), centred s metres from a."""
    a, t, n = wall_frame(a, b)

    def outline(hw, zb, ht):
        r = 2 * hw  # equilateral arch: radius = width
        zs = zb + ht - r * math.sqrt(3) / 2
        pts = [(-hw, zb), (hw, zb), (hw, zs)]
        for k in range(1, seg):  # right arc centred at -hw
            ang = math.radians(60 * k / seg)
            pts.append((-hw + r * math.cos(ang), zs + r * math.sin(ang)))
        pts.append((0, zb + ht))
        for k in range(seg - 1, 0, -1):  # left arc centred at +hw
            ang = math.radians(60 * k / seg)
            pts.append((hw - r * math.cos(ang), zs + r * math.sin(ang)))
        pts.append((-hw, zs))
        return pts

    inner = outline(w / 2, z0, h)
    uvs = [((x + w / 2) / w, (z - z0) / h) for x, z in inner]
    B.face([on_wall(a, t, n, s + x, z, d) for x, z in inner], mat, out=(n.x, n.y, 0), uvs=uvs)
    fw = 0.16
    outer = outline(w / 2 + fw, z0 - fw, h + 2 * fw)
    for i in range(len(inner)):
        j = (i + 1) % len(inner)
        q = [on_wall(a, t, n, s + inner[i][0], inner[i][1], d + 0.03),
             on_wall(a, t, n, s + inner[j][0], inner[j][1], d + 0.03),
             on_wall(a, t, n, s + outer[j][0], outer[j][1], d + 0.03),
             on_wall(a, t, n, s + outer[i][0], outer[i][1], d + 0.03)]
        B.face(q, frame, out=(n.x, n.y, 0))
    if mullion:
        zs = z0 + h - w * math.sqrt(3) / 2
        flat(B, a, t, n, s, 0.12, z0, zs + 0.25, frame, d + 0.04)






def circle_window(B, a, b, s, zc, r, mat='StainedGlass', frame='Stone', seg=20, d=0.05):
    a, t, n = wall_frame(a, b)
    ring = [(math.cos(2 * math.pi * k / seg), math.sin(2 * math.pi * k / seg)) for k in range(seg)]
    B.face([on_wall(a, t, n, s + r * x, zc + r * y, d) for x, y in ring], mat, out=(n.x, n.y, 0),
           uvs=[(0.5 + x / 2, 0.5 + y / 2) for x, y in ring])
    ro = r + 0.3
    for k in range(seg):
        j = (k + 1) % seg
        (x0, y0), (x1, y1) = ring[k], ring[j]
        B.face([on_wall(a, t, n, s + r * x0, zc + r * y0, d + 0.03), on_wall(a, t, n, s + r * x1, zc + r * y1, d + 0.03),
                on_wall(a, t, n, s + ro * x1, zc + ro * y1, d + 0.03), on_wall(a, t, n, s + ro * x0, zc + ro * y0, d + 0.03)],
               frame, out=(n.x, n.y, 0))


def buttress(B, base, out_dir, width, depth, z_top, z_step=None, mat='Brick', cap='Stone'):
    """Buttress at `base` (on the wall line) pointing along out_dir, sloped stone cap on top."""
    o = V(out_dir).normalized()
    s = V((-o.y, o.x))
    base = V(base)
    q = lambda along, off: base + o * along + s * off
    hw = width / 2
    z_mid = z_top - depth * 1.6
    # sides (profile: vertical outer face up to z_mid, slope back to the wall at z_top)
    for sign in (-1, 1):
        p = [q(0, sign * hw), q(depth, sign * hw)]
        B.face([(p[0].x, p[0].y, SINK), (p[1].x, p[1].y, SINK), (p[1].x, p[1].y, z_mid), (p[0].x, p[0].y, z_top)],
               mat, out=(s.x * sign, s.y * sign, 0))
    a, b = q(depth, -hw), q(depth, hw)
    B.face([(a.x, a.y, SINK), (b.x, b.y, SINK), (b.x, b.y, z_mid), (a.x, a.y, z_mid)], mat, out=(o.x, o.y, 0))
    c, d = q(0, -hw), q(0, hw)
    B.face([(a.x, a.y, z_mid), (b.x, b.y, z_mid), (d.x, d.y, z_top), (c.x, c.y, z_top)], cap, out=(o.x, o.y, 1))
    if z_step:  # a stone water table halfway up
        a1, b1 = q(depth + 0.12, -hw - 0.06), q(depth + 0.12, hw + 0.06)
        B.face([(a1.x, a1.y, z_step), (b1.x, b1.y, z_step), (b1.x, b1.y, z_step + 0.25), (a1.x, a1.y, z_step + 0.25)],
               cap, out=(o.x, o.y, 0))


def octagon(cu, cv, a, rot=22.5):
    r = a / math.cos(math.radians(22.5))
    return [(cu + r * math.cos(math.radians(rot + 45 * k)), cv + r * math.sin(math.radians(rot + 45 * k))) for k in range(8)]


def pyramid(B, poly, z0, apex, mat):
    poly = ccw([V(p).to_2d() for p in poly])
    for a, b, t, n in edges(poly):
        B.face([(a.x, a.y, z0), (b.x, b.y, z0), apex], mat, out=(n.x, n.y, 0.5))


# ---------------------------------------------------------------- the church

WING_IN, WING_OUT = 12.2, 8.8  # wing roof heights at the tower and at the outer wall
CANOPY = (-32.4, -10.4, 4.4, 3.9)  # u front, v south, v north, underside z


def wing(B, u0, u1, v_in, v_out, z_in, z_out, col=False):
    """Brick block u0..u1 between the tower side (v_in) and its outer wall (v_out), roof falling outwards."""
    wm, rm, cm = ('x', 'x', 'x') if col else ('BrickRed', 'RoofFlat', 'Concrete')
    o = 1 if v_out > v_in else -1
    for u, out in ((u0, -1), (u1, 1)):  # trapezoid end walls
        B.face([(u, v_in, SINK), (u, v_out, SINK), (u, v_out, z_out), (u, v_in, z_in)], wm, out=(out, 0, 0))
    B.face([(u0, v_out, SINK), (u1, v_out, SINK), (u1, v_out, z_out), (u0, v_out, z_out)], wm, out=(0, o, 0))
    B.face([(u0, v_in, SINK), (u1, v_in, SINK), (u1, v_in, z_in), (u0, v_in, z_in)], wm, out=(0, -o, 0))
    B.face([(u0, v_in, z_in), (u1, v_in, z_in), (u1, v_out, z_out), (u0, v_out, z_out)], rm, out=(0, 0, 1))
    if col:
        return
    # coping: thin concrete band on top of the sloping end walls and along the outer eave
    for u in (u0, u1):
        ua, ub = u - 0.12, u + 0.12
        for side, uu in ((-1, ua), (1, ub)):
            B.face([(uu, v_in, z_in), (uu, v_out + o * 0.1, z_out), (uu, v_out + o * 0.1, z_out + 0.25), (uu, v_in, z_in + 0.25)],
                   cm, out=(side, 0, 0))
        B.face([(ua, v_in, z_in + 0.25), (ub, v_in, z_in + 0.25), (ub, v_out + o * 0.1, z_out + 0.25), (ua, v_out + o * 0.1, z_out + 0.25)],
               cm, out=(0, 0, 1))
        B.face([(ua, v_out + o * 0.1, z_out), (ub, v_out + o * 0.1, z_out), (ub, v_out + o * 0.1, z_out + 0.25),
                (ua, v_out + o * 0.1, z_out + 0.25)], cm, out=(0, o, 0))
    B.face([(u0, v_out + o * 0.1, z_out - 0.25), (u1, v_out + o * 0.1, z_out - 0.25), (u1, v_out + o * 0.1, z_out),
            (u0, v_out + o * 0.1, z_out)], cm, out=(0, o, 0))


def entrance(B):
    """West portal: dark brick pilasters framing the tower, cantilevered concrete canopy, piers, door, steps."""
    u0, _, v0, v1 = TOWER
    uf, vs_, vn_, zc = CANOPY
    # pilasters at the tower's front corners, full shaft height
    for va, vb in ((v0 - 0.15, v0 + 0.85), (v1 - 0.85, v1 + 0.15)):
        box(B, u0 - 0.35, u0 + 0.01, va, vb, SINK, 21.0, 'BrickDark')
    # canopy slab with a slim fascia that turns up slightly at the front
    # reaches back to the wings' front (u -27.3); the part inside the tower is hidden
    prism(B, [(uf, vs_), (-27.3, vs_), (-27.3, vn_), (uf, vn_)], zc, zc + 0.22, 'Concrete', top='Concrete', bottom=True)
    box(B, uf - 0.08, uf + 0.12, vs_ - 0.08, vn_ + 0.08, zc - 0.05, zc + 0.38, 'Concrete')
    # vestibule front under the canopy: dark brick wall with piers, central double door with a transom
    a, t, n = wall_frame((u0, v1), (u0, v0))
    W = v1 - v0
    flat(B, a, t, n, W / 2, W - 2.0, SINK, zc, 'BrickDark', 0.12)
    for s in (1.6, 2.6, W - 2.6, W - 1.6):
        box(B, u0 - 0.55, u0 - 0.12, v1 - s - 0.28, v1 - s + 0.28, SINK, zc, 'BrickDark')
    c = W / 2
    flat(B, a, t, n, c, 3.1, 0.0, 3.25, 'Louver', 0.14)              # dark reveal
    flat(B, a, t, n, c - 0.72, 1.36, 0.0, 2.55, 'Door', 0.16)         # door leaves
    flat(B, a, t, n, c + 0.72, 1.36, 0.0, 2.55, 'Door', 0.16)
    flat(B, a, t, n, c, 0.06, 0.0, 2.55, 'Louver', 0.17)
    flat(B, a, t, n, c, 2.9, 2.68, 3.15, 'GlassModern', 0.16)         # transom
    for k in range(1, 4):
        flat(B, a, t, n, c - 1.45 + 2.9 * k / 4, 0.05, 2.68, 3.15, 'Frame', 0.17)
    for x in (-0.36, 0.36):                                           # door panels
        for side in (-0.72, 0.72):
            flat(B, a, t, n, c + side + x * 0.9, 0.04, 0.25, 2.35, 'Louver', 0.17)
    # wide low steps across the whole front
    for z0, z1, du in ((SINK, 0.16, 1.6), (0.16, 0.32, 0.8)):
        prism(B, [(u0 - du - 0.8, -11.6), (u0, -11.6), (u0, 4.6), (u0 - du - 0.8, 4.6)], z0, z1, 'Stone', top='Stone')

APSE = oct_end(22.4, VC, 0)                    # chancel end, east
TN = oct_end(7.95, 7.25, 90)                   # north transept end
TS = oct_end(7.95, -11.35, -90)                # south transept end
MAIN = [(-19.6, VC - AP), *APSE, (-19.6, VC + AP)]
TRANS = [*TS, *TN]
MAIN_RIDGE = [(-19.6, VC), (22.4, VC)]
TRANS_RIDGE = [(7.95, -11.35), (7.95, 7.25)]
TOWER = (-29.1, -19.6, VC - 4.75, VC + 4.75)


def build_church(B):
    vs, vn = VC - AP, VC + AP  # south / north wall lines of nave and chancel
    # --- main masses
    prism(B, MAIN, SINK, Z_WALL, 'Brick')
    prism(B, TRANS, SINK, Z_WALL, 'Brick')
    roof(B, MAIN, MAIN_RIDGE, Z_WALL, Z_RIDGE, AP, 'Slate')
    roof(B, TRANS, TRANS_RIDGE, Z_WALL, Z_RIDGE, AP, 'Slate')
    # eave cornice (stone band just under the roof)
    for poly in (MAIN, TRANS):
        p = ccw([V(q) for q in poly])
        for a, b, t, n in edges(p):
            if abs(a.x - b.x) < 1e-6 and abs(a.x + 19.6) < 1e-6:
                continue
            flat(B, a, t, n, (b - a).length / 2, (b - a).length, Z_WALL - 0.75, Z_WALL - 0.45, 'Stone', 0.06)

    # --- north aisle (lean-to, buttressed) and clerestory
    box(B, -19.6, 2.7, vn, 9.5, SINK, 7.0, 'Brick')
    lean_to(B, -19.6, 2.7, 9.5, vn, 7.0, 10.2, 'Slate')
    for u in BAYS:
        buttress(B, (u, 9.5), (0, 1), 0.95, 1.1, 7.6, z_step=2.0)
    for u in BAY_CENTRES:
        lancet(B, (2.7, 9.5), (-19.6, 9.5), 2.7 - u, 1.3, 2.0, 4.4)   # aisle windows (wall faces north)
    # clerestory on the nave walls (wall a→b chosen so the outward normal points away from the nave)
    for u in BAY_CENTRES:
        lancet(B, (2.7, vn), (-19.6, vn), 2.7 - u, 1.0, 11.0, 3.2)
        lancet(B, (-19.6, vs), (2.7, vs), u + 19.6, 1.0, 9.0, 4.8)
    for u in BAYS:  # pilaster strips between clerestory windows
        a, t, n = wall_frame((2.7, vn), (-19.6, vn))
        flat(B, a, t, n, 2.7 - u, 0.6, 10.2, Z_WALL - 0.75, 'Brick', 0.15)
        a, t, n = wall_frame((-19.6, vs), (2.7, vs))
        flat(B, a, t, n, u + 19.6, 0.6, 6.0, Z_WALL - 0.75, 'Brick', 0.15)

    # --- south aisle: post-war red brick hall with flat roof and white fascia
    box(B, -19.6, 2.7, -13.9, vs, SINK, 5.0, 'BrickRed')
    prism(B, [(-19.6, -15.1), (2.7, -15.1), (2.7, vs), (-19.6, vs)], 5.0, 6.0, 'Concrete', top='RoofFlat', bottom=True)
    for u in BAYS[:-1]:
        box(B, u - 0.475, u + 0.475, -15.0, -13.9, SINK, 5.0, 'BrickRed')
    for u in BAY_CENTRES:
        for o in (-1.25, 1.25):
            rect_window(B, (-19.6, -13.9), (2.7, -13.9), u + o + 19.6, 1.7, 1.2, 3.6, mat='Shutter', panes=1)

    # --- chancel and apse
    for u in (15.6, 19.9):
        lancet(B, (22.4, vn), (13.2, vn), 22.4 - u, 1.3, 7.5, 6.6, mullion=True)
        lancet(B, (13.2, vs), (24.57, vs), u - 13.2, 1.3, 4.0, 9.8, mullion=True)
    for i in range(3):
        a, b = APSE[i], APSE[i + 1]
        lancet(B, a, b, (V(b) - V(a)).length / 2, 1.4, 3.5, 10.3, mullion=True)
    for p in APSE:  # corner buttresses along the bisector
        d = (V(p) - V((22.4, VC))).normalized()
        buttress(B, V(p) - d * 0.3, d, 0.95, 1.6, 13.0, z_step=6.0)

    # --- transept ends
    for end, centre in ((TN, (7.95, 7.25)), (TS, (7.95, -11.35))):
        for i in range(3):
            a, b = end[i], end[i + 1]
            # transept ends are listed CCW of the whole transept polygon, so a→b has the outward normal on the right
            wide = i == 1
            lancet(B, a, b, (V(b) - V(a)).length / 2, 1.6 if wide else 1.2, 4.0, 9.6 if wide else 8.8, mullion=wide)
        for p in end:
            d = (V(p) - V(centre)).normalized()
            buttress(B, V(p) - d * 0.3, d, 0.95, 1.4, 12.0, z_step=5.0)
    lancet(B, (13.2, vn), (13.2, 9.425), 3.2, 1.2, 7.2, 6.8)          # north transept, east wall above sacristy
    lancet(B, (2.7, 9.425), (2.7, vn), 3.2, 1.0, 11.0, 3.2)           # north transept, west wall above aisle roof
    lancet(B, (13.2, -13.525), (13.2, vs), 3.0, 1.2, 3.5, 9.6)        # south transept, east wall
    lancet(B, (2.7, vs), (2.7, -13.525), 3.0, 1.0, 7.5, 5.6)          # south transept, west wall above the hall

    # --- sacristy (north-east) and chimney
    box(B, 13.2, 22.0, vn, 12.5, SINK, 6.0, 'Brick', top='RoofFlat')
    for u0, u1 in ((13.2, 22.0),):
        prism(B, [(u0 - 0.05, vn), (u1 + 0.1, vn), (u1 + 0.1, 12.6), (u0 - 0.05, 12.6)], 6.0, 6.3, 'Stone', top='Stone')
    for u in (15.0, 17.6, 20.2):
        rect_window(B, (22.0, 12.5), (13.2, 12.5), 22.0 - u, 1.2, 2.0, 4.2, panes=2)
    for v in (6.0, 9.5):
        rect_window(B, (22.0, vn), (22.0, 12.5), v - vn, 1.2, 2.0, 4.2, panes=2)
    box(B, 13.25, 14.15, vn - 0.95, vn - 0.05, 10.0, 21.8, 'Brick')
    box(B, 13.15, 14.25, vn - 1.05, vn + 0.05, 21.8, 22.1, 'Stone')

    # --- west wings: red brick, mono-pitch roofs rising towards the tower, light coping along the slope
    tn, ts = TOWER[3], TOWER[2]
    wing(B, -27.3, -19.6, tn, 10.45, WING_IN, WING_OUT)
    wing(B, -27.3, -19.6, ts, -15.0, WING_IN, WING_OUT)
    rect_window(B, (-19.6, 10.45), (-27.3, 10.45), 4.0, 4.6, 5.2, 7.9, panes=3)
    rect_window(B, (-19.6, 10.45), (-27.3, 10.45), 4.0, 2.4, 0.0, 2.7, panes=2, sill=False)
    rect_window(B, (-27.3, -15.0), (-19.6, -15.0), 3.7, 3.0, 2.0, 4.0, panes=3)
    for a, b in (((-27.3, 10.45), (-27.3, tn)), ((-27.3, ts), (-27.3, -15.0))):  # dark plinth on the west front
        a2, t, n = wall_frame(a, b)
        L = (V(b) - V(a)).length
        flat(B, a2, t, n, L / 2, L, SINK, 0.55, 'BrickDark', 0.03)

    # --- west tower
    u0, u1, v0, v1 = TOWER
    box(B, u0, u1, v0, v1, SINK, 21.0, 'Brick')
    box(B, u0 - 0.1, u1 + 0.1, v0 - 0.1, v1 + 0.1, 21.0, 21.35, 'Stone')
    box(B, u0 + 0.3, u1 - 0.3, v0 + 0.3, v1 - 0.3, 21.35, 28.0, 'Brick')
    box(B, u0 - 0.15, u1 + 0.15, v0 - 0.15, v1 + 0.15, 28.0, 28.35, 'Stone')
    # parapet ring with corner posts
    w = 0.3
    for a in ((u0 - 0.1, u1 + 0.1, v0 - 0.1, v0 - 0.1 + w), (u0 - 0.1, u1 + 0.1, v1 + 0.1 - w, v1 + 0.1),
              (u0 - 0.1, u0 - 0.1 + w, v0 - 0.1, v1 + 0.1), (u1 + 0.1 - w, u1 + 0.1, v0 - 0.1, v1 + 0.1)):
        box(B, *a, 28.35, 29.2, 'Stone')
    for cu in (u0 - 0.1, u1 + 0.1 - 0.55):
        for cv in (v0 - 0.1, v1 + 0.1 - 0.55):
            box(B, cu, cu + 0.55, cv, cv + 0.55, 28.35, 30.0, 'Stone')
    tc = ((u0 + u1) / 2, (v0 + v1) / 2)
    sq = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    sq2 = [(u0 + 0.3, v0 + 0.3), (u1 - 0.3, v0 + 0.3), (u1 - 0.3, v1 - 0.3), (u0 + 0.3, v1 - 0.3)]
    for i in range(4):
        a, b = sq[i], sq[(i + 1) % 4]
        L = (V(b) - V(a)).length
        if i in (0, 2):  # south and north faces (east is behind the nave roof, west has the oculus)
            for o in (-0.8, 0.8):
                lancet(B, a, b, L / 2 + o, 0.7, 14.5, 5.6, mat='Louver')
        a2, b2 = sq2[i], sq2[(i + 1) % 4]
        for o in (-0.95, 0.95):
            lancet(B, a2, b2, (V(b2) - V(a2)).length / 2 + o, 0.85, 22.4, 4.8, mat='Louver')
    west = (sq[3], sq[0])
    circle_window(B, *west, 4.75, 15.0, 1.9)
    # octagonal belfry and spire
    bel = octagon(*tc, 3.6)
    prism(B, bel, 28.35, 36.6, 'Brick')
    prism(B, octagon(*tc, 3.75), 36.6, 36.95, 'Stone', top=None)
    for i in range(8):
        a, b = bel[i], bel[(i + 1) % 8]
        lancet(B, a, b, (V(b) - V(a)).length / 2, 1.0, 30.2, 5.2, mat='Louver')
    pyramid(B, octagon(*tc, 3.95), 36.95, (tc[0], tc[1], 53.0), 'Slate')
    box(B, tc[0] - 0.07, tc[0] + 0.07, tc[1] - 0.07, tc[1] + 0.07, 52.5, 55.6, 'Gold')
    box(B, tc[0] - 0.07, tc[0] + 0.07, tc[1] - 0.55, tc[1] + 0.55, 54.5, 54.66, 'Gold')

    entrance(B)


def build_collision(B):
    vs, vn = VC - AP, VC + AP
    prism(B, MAIN, SINK, Z_WALL, 'x', top=None)
    prism(B, TRANS, SINK, Z_WALL, 'x', top=None)
    roof(B, MAIN, MAIN_RIDGE, Z_WALL, Z_RIDGE, AP, 'x', overhang=0.0, wall_mat='x', soffit_mat='x')
    roof(B, TRANS, TRANS_RIDGE, Z_WALL, Z_RIDGE, AP, 'x', overhang=0.0, wall_mat='x', soffit_mat='x')
    box(B, -19.6, 2.7, vn, 10.6, SINK, 7.0, 'x')
    lean_to(B, -19.6, 2.7, 10.6, vn, 7.0, 10.2, 'x', overhang=0.0, wall_mat='x')
    box(B, -19.6, 2.7, -15.1, vs, SINK, 6.0, 'x')
    box(B, 13.2, 22.0, vn, 12.5, SINK, 6.3, 'x')
    wing(B, -27.3, -19.6, TOWER[3], 10.45, WING_IN, WING_OUT, col=True)
    wing(B, -27.3, -19.6, TOWER[2], -15.0, WING_IN, WING_OUT, col=True)
    u0, u1, v0, v1 = TOWER
    box(B, u0, u1, v0, v1, SINK, 28.35, 'x')
    tc = ((u0 + u1) / 2, (v0 + v1) / 2)
    prism(B, octagon(*tc, 3.6), 28.35, 36.95, 'x')
    pyramid(B, octagon(*tc, 3.95), 36.95, (tc[0], tc[1], 53.0), 'x')
    box(B, CANOPY[0], -27.3, CANOPY[1], CANOPY[2], CANOPY[3], CANOPY[3] + 0.3, 'x')
    for z0, z1, du in ((SINK, 0.16, 1.6), (0.16, 0.32, 0.8)):  # entrance steps
        box(B, -29.1 - du - 0.8, -29.1, -11.6, 4.6, z0, z1, 'x')


def main():
    coll = reset_collection('ST_MARIEN')
    B = Builder(make_materials())
    build_church(B)
    church = B.to_object(NAME, coll, ORIGIN, THETA)
    C = Builder()
    build_collision(C)
    col = C.to_object(f'{NAME}_col', coll, ORIGIN, THETA)
    col.display_type = 'WIRE'
    col.hide_render = True
    return church, col


church, col = main()
stats = {'tris': tris(church), 'col_tris': tris(col)}
if globals().get('EXPORT', True):
    export_glb(os.path.join(HERE, f'{NAME}.glb'), [church, col])
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, f'{NAME}.blend'), copy=True)
