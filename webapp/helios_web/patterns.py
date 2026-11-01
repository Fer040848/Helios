"""Pattern registry: each generator returns strokes in pattern space ([-1, 1], before size/position).

Generators take ``(scene, t, size)`` where ``t`` is the animation clock (seconds already multiplied by
``scene.speed``) and ``size`` is the scale the engine will apply (used by scrolling text to cover the whole window).
"""

import math

from . import font
from .geometry import Stroke, polygon


def _circle_points(radius, n=72, phase=0.0):
    return [
        (
            radius * math.cos(phase + 2 * math.pi * k / n),
            radius * math.sin(phase + 2 * math.pi * k / n),
        )
        for k in range(n)
    ]


def circle(scene, t, size):
    return [Stroke(_circle_points(1.0), True)]


def square(scene, t, size):
    return [Stroke(polygon(4, 1.0, 45.0), True)]


def triangle(scene, t, size):
    return [Stroke(polygon(3, 1.0, 90.0), True)]


def star(scene, t, size):
    pts = []
    for k in range(10):
        r = 1.0 if k % 2 == 0 else 0.4
        a = math.pi / 2 + math.pi * k / 5
        pts.append((r * math.cos(a), r * math.sin(a)))
    return [Stroke(pts, True)]


def heart(scene, t, size):
    pts = []
    for k in range(80):
        u = 2 * math.pi * k / 80
        x = 16 * math.sin(u) ** 3
        y = (
            13 * math.cos(u)
            - 5 * math.cos(2 * u)
            - 2 * math.cos(3 * u)
            - math.cos(4 * u)
        )
        pts.append((x / 17.0, (y + 2.5) / 17.0))
    return [Stroke(pts, True)]


def line(scene, t, size):
    return [Stroke([(-1.0, 0.0), (1.0, 0.0)], False)]


def spiral(scene, t, size):
    turns, n = 4, 160
    phase = t * 2.0
    pts = []
    for k in range(n + 1):
        f = k / n
        r = 0.05 + 0.95 * f
        a = phase + 2 * math.pi * turns * f
        pts.append((r * math.cos(a), r * math.sin(a)))
    return [Stroke(pts, False)]


def wave(scene, t, size):
    n = 90
    return [
        Stroke(
            [
                (
                    -1 + 2 * k / n,
                    0.5 * math.sin(3 * math.pi * (-1 + 2 * k / n) + t * 3.0),
                )
                for k in range(n + 1)
            ],
            False,
        )
    ]


def lissajous(scene, t, size):
    n = 180
    return [
        Stroke(
            [
                (math.sin(3 * u + t * 0.7), math.sin(2 * u))
                for u in (2 * math.pi * k / n for k in range(n))
            ],
            True,
        )
    ]


def tunnel(scene, t, size):
    rings = 4
    out = []
    for k in range(rings):
        r = ((k / rings) + t * 0.3) % 1.0
        if r > 0.06:
            out.append(Stroke(_circle_points(r, 48), True))
    return out


def fan(scene, t, size):
    beams = 7
    spread = 0.65 + 0.35 * math.sin(t * 1.5)
    return [
        Stroke([((-1 + 2 * k / (beams - 1)) * spread, 0.0)], False)
        for k in range(beams)
    ]


def grid(scene, t, size):
    lines, out = 5, []
    for k in range(lines):
        v = -1 + 2 * k / (lines - 1)
        a, b = (-1.0, v), (1.0, v)
        out.append(
            Stroke([a, b] if k % 2 == 0 else [b, a], False)
        )  # serpentine: short blank jumps
    for k in range(lines):
        v = 1 - 2 * k / (lines - 1)
        a, b = (v, 1.0), (v, -1.0)
        out.append(Stroke([a, b] if k % 2 == 0 else [b, a], False))
    return out


def flower(scene, t, size):
    petals, n = 5, 200
    phase = t * 0.3
    pts = []
    for k in range(n):
        u = math.pi * k / n  # r = cos(5u) closes over [0, pi] with 5 petals
        r = math.cos(petals * u)
        pts.append((r * math.cos(u + phase), r * math.sin(u + phase)))
    return [Stroke(pts, True)]


TEXT_HEIGHT_STATIC = 1.0  # max text height in pattern space
TEXT_HEIGHT_SCROLL = 0.8
SCROLL_SPEED = 0.6  # world units per second at speed 1


def text(scene, t, size):
    polylines, width = font.layout(scene.get("text", ""))
    if not polylines:
        return []
    if scene.get("textMode") == "scroll":
        s = TEXT_HEIGHT_SCROLL / font.CAP_HEIGHT
        window = 1.0 / max(
            size, 0.05
        )  # half-width of the visible window in pattern space
        travel = 2 * window + width * s
        x0 = window - (t * SCROLL_SPEED / max(size, 0.05)) % travel
    else:
        s = min(1.9 / width if width else 1.0, TEXT_HEIGHT_STATIC / font.CAP_HEIGHT)
        x0 = -width * s / 2
    y0 = -font.CAP_HEIGHT * s / 2
    return [
        Stroke([(x0 + x * s, y0 + y * s) for x, y in pl], False) for pl in polylines
    ]


def drawing(scene, t, size):
    """Drawn 1:1 with the phone canvas: undo the engine's ``size`` scaling (rotation/position/effects still apply)."""
    if size < 0.01:
        return []
    k = 1.0 / size
    return [
        Stroke([(p[0] * k, p[1] * k) for p in st], False)
        for st in scene.get("drawing", [])
        if st
    ]


GENERATORS = {
    "circle": circle,
    "square": square,
    "triangle": triangle,
    "star": star,
    "heart": heart,
    "line": line,
    "spiral": spiral,
    "wave": wave,
    "lissajous": lissajous,
    "tunnel": tunnel,
    "fan": fan,
    "grid": grid,
    "flower": flower,
    "text": text,
    "drawing": drawing,
}


def generate(scene, t, size):
    return GENERATORS[scene["pattern"]](scene, t, size)
