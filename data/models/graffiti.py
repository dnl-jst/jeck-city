"""Procedural graffiti for the building models: bubble-letter pieces and handwritten tags in one RGBA atlas.

graffiti_atlas(seed) → (H×W×4 float array, {name: (u0, v0, u1, v1)}) with UV rects (v up, Blender/glTF
convention after the image is stored bottom-up). Pure numpy, no Blender needed (except for _img).
"""
import math

import numpy as np

# stroke font on a unit box (x right, y up); each glyph is a list of polylines
_O = [[(0.5 + 0.5 * math.cos(2 * math.pi * k / 16), 0.5 + 0.5 * math.sin(2 * math.pi * k / 16)) for k in range(17)]]
_P = [[(0, 0), (0, 1), (0.75, 1), (1, 0.85), (1, 0.65), (0.75, 0.5), (0, 0.5)]]
GLYPHS = {
    'A': [[(0, 0), (0.5, 1), (1, 0)], [(0.22, 0.42), (0.78, 0.42)]],
    'C': [[(1, 0.85), (0.7, 1), (0.3, 1), (0, 0.7), (0, 0.3), (0.3, 0), (0.7, 0), (1, 0.15)]],
    'E': [[(1, 1), (0, 1), (0, 0), (1, 0)], [(0, 0.5), (0.75, 0.5)]],
    'F': [[(1, 1), (0, 1), (0, 0)], [(0, 0.5), (0.7, 0.5)]],
    'H': [[(0, 0), (0, 1)], [(1, 0), (1, 1)], [(0, 0.5), (1, 0.5)]],
    'I': [[(0.5, 0), (0.5, 1)]],
    'K': [[(0, 0), (0, 1)], [(1, 1), (0.05, 0.45), (1, 0)]],
    'L': [[(0, 1), (0, 0), (1, 0)]],
    'N': [[(0, 0), (0, 1), (1, 0), (1, 1)]],
    'O': _O,
    'P': _P,
    'R': _P + [[(0.45, 0.5), (1, 0)]],
    'S': [[(1, 0.88), (0.75, 1), (0.25, 1), (0, 0.8), (0.05, 0.62), (0.95, 0.38), (1, 0.2), (0.75, 0), (0.25, 0), (0, 0.12)]],
    'T': [[(0, 1), (1, 1)], [(0.5, 1), (0.5, 0)]],
    'U': [[(0, 1), (0, 0.25), (0.25, 0), (0.75, 0), (1, 0.25), (1, 1)]],
    'X': [[(0, 0), (1, 1)], [(0, 1), (1, 0)]],
    'Z': [[(0, 1), (1, 1), (0, 0), (1, 0)]],
    '4': [[(0.75, 0), (0.75, 1), (0, 0.35), (1, 0.35)]],
    '7': [[(0, 1), (1, 1), (0.35, 0)]],
}

FILLS = [(0.93, 0.35, 0.62), (0.25, 0.75, 0.92), (0.98, 0.82, 0.18), (0.55, 0.32, 0.85), (0.92, 0.25, 0.18),
         (0.35, 0.82, 0.38), (0.98, 0.55, 0.15), (0.86, 0.86, 0.90)]


def _segments(glyph_lines, x0, y0, w, h, slant, rot, rng, wobble):
    """Glyph polylines → segment array (n, 4) in pixel space."""
    c = np.array([x0 + w / 2, y0 + h / 2])
    ca, sa = math.cos(rot), math.sin(rot)
    segs = []
    for line in glyph_lines:
        pts = []
        for x, y in line:
            px = x0 + x * w + (y - 0.5) * slant * h + rng.normal(0, wobble)
            py = y0 + y * h + rng.normal(0, wobble)
            d = np.array([px, py]) - c
            pts.append(c + [d[0] * ca - d[1] * sa, d[0] * sa + d[1] * ca])
        segs += [(*a, *b) for a, b in zip(pts, pts[1:])]
    return segs


def _dist(H, W, segs):
    """Distance from every pixel (y up) to the nearest segment."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    best = np.full((H, W), 1e9, np.float32)
    for ax, ay, bx, by in segs:
        dx, dy = bx - ax, by - ay
        L2 = max(dx * dx + dy * dy, 1e-6)
        t = np.clip(((xx - ax) * dx + (yy - ay) * dy) / L2, 0, 1)
        best = np.minimum(best, np.hypot(xx - ax - t * dx, yy - ay - t * dy))
    return best


def piece(word, W, H, rng, fill=None, fill2=None):
    """Bubble-letter piece: gradient fill, dark outline, white highlight, a few drips. RGBA, y up."""
    n = len(word)
    lh = H * 0.56
    adv = min(lh * 0.82, W * 0.86 / n)
    lw = adv * 0.82
    x = (W - adv * n) / 2 + adv * 0.09
    r = lh * 0.15
    segs = []
    for ch in word:
        if ch != ' ':
            y0 = (H - lh) / 2 + rng.uniform(-0.06, 0.06) * lh
            s = rng.uniform(0.92, 1.1)
            segs += _segments(GLYPHS[ch], x, y0, lw * s, lh * s, 0.18, math.radians(rng.uniform(-9, 9)), rng, lh * 0.012)
        x += adv
    d = _dist(H, W, segs)
    fill = np.array(fill or FILLS[rng.integers(len(FILLS))], np.float32)
    fill2 = np.array(fill2 or FILLS[rng.integers(len(FILLS))], np.float32)
    yy = np.mgrid[0:H, 0:W][0] / H
    grad = np.clip((yy - 0.3) / 0.45, 0, 1)[..., None]
    rgb = fill2 * (1 - grad) + fill * grad
    out = np.zeros((H, W, 4), np.float32)
    o = r * 0.38
    inner = d < r
    outline = (d < r + o) & ~inner
    out[inner, :3] = rgb[inner]
    out[outline, :3] = (0.05, 0.05, 0.07)
    out[inner | outline, 3] = 1
    # highlight: thin white crescent towards the upper left
    sh = int(r * 0.35)
    shifted = np.full_like(d, 1e9)
    shifted[:-sh or None, sh:] = d[sh:, :-sh or None]
    hl = inner & (shifted > r * 0.7) & (d < r * 0.75)
    out[hl, :3] = 0.97
    # drips below the fill
    ys, xs = np.nonzero(inner)
    for _ in range(int(rng.integers(3, 8))):
        k = rng.integers(len(xs))
        x0, y0 = xs[k], ys[k]
        if y0 > H * 0.45:
            continue
        L = int(rng.uniform(0.08, 0.25) * H)
        wdt = max(2, int(r * 0.18))
        y1 = max(0, y0 - L)
        out[y1:y0, x0 - wdt:x0 + wdt, :3] = rgb[y0, x0]
        out[y1:y0, x0 - wdt:x0 + wdt, 3] = 1
    _wear(out, rng)
    return out


def tag(word, W, H, rng, color=None):
    """Quick handwritten tag: thin, slanted, connected, with an underline swoosh."""
    n = len(word)
    lh = H * 0.45
    adv = W * 0.8 / n
    x = W * 0.08
    segs = []
    for ch in word:
        y0 = H * 0.32 + rng.uniform(-0.05, 0.05) * H
        segs += _segments(GLYPHS[ch], x, y0, adv * 0.75, lh, 0.45, math.radians(rng.uniform(-6, 6)), rng, lh * 0.03)
        x += adv
    swoosh = [(W * 0.06, H * 0.24), (W * 0.4, H * 0.16), (W * 0.9, H * 0.22), (W * 0.96, H * 0.3)]
    segs += [(*a, *b) for a, b in zip(swoosh, swoosh[1:])]
    d = _dist(H, W, segs)
    col = np.array(color or [(0.08, 0.08, 0.1), (0.55, 0.1, 0.55), (0.75, 0.1, 0.1), (0.1, 0.25, 0.7)][rng.integers(4)], np.float32)
    out = np.zeros((H, W, 4), np.float32)
    m = d < max(2.5, lh * 0.05)
    out[m, :3] = col
    out[m, 3] = 1
    _wear(out, rng)
    return out


def _wear(img, rng):
    """Speckled paint loss so the decals don't look printed."""
    H, W = img.shape[:2]
    holes = rng.uniform(0, 1, (H, W)) < 0.012
    img[holes, 3] = 0


PIECES = [('NIPPES', (0, 0, 768, 256)), ('ZOFF', (0, 256, 768, 512)), ('KOLO', (0, 512, 768, 768)),
          ('TRAX', (0, 768, 512, 1024)), ('OLE', (512, 768, 1024, 1024))]
TAGS = [('SKE', (768, 0, 1024, 128)), ('RAZ', (768, 128, 1024, 256)), ('NIX', (768, 256, 1024, 384)),
        ('KO4', (768, 384, 1024, 512)), ('ZET', (768, 512, 1024, 640)), ('LUX', (768, 640, 1024, 768))]


def graffiti_atlas(seed=7, size=1024):
    """RGBA atlas (y up) and the UV rect of every piece/tag by word."""
    rng = np.random.default_rng(seed)
    atlas = np.zeros((size, size, 4), np.float32)
    rects = {}
    for i, (word, (x0, y0, x1, y1)) in enumerate(PIECES):
        chrome = i == 2
        img = piece(word, x1 - x0, y1 - y0, rng, *(((0.86, 0.86, 0.9), (0.6, 0.62, 0.68)) if chrome else ()))
        atlas[y0:y1, x0:x1] = img
        rects[word] = (x0 / size, y0 / size, x1 / size, y1 / size)
    for word, (x0, y0, x1, y1) in TAGS:
        atlas[y0:y1, x0:x1] = tag(word, x1 - x0, y1 - y0, rng)
        rects[word] = (x0 / size, y0 / size, x1 / size, y1 / size)
    return atlas, rects
