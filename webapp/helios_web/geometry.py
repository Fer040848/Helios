"""Stroke types and geometric helpers.

A ``Stroke`` is a polyline of ``(x, y)`` vertices; a ``ColoredStroke`` carries ``(x, y, r, g, b)`` vertices where
the colour is that of the segment starting at the vertex. ``closed`` strokes join their last vertex to the first.
"""

import math
from collections import namedtuple

Stroke = namedtuple("Stroke", "points closed")
ColoredStroke = namedtuple("ColoredStroke", "points closed")


def polygon(sides, radius=1.0, phase_deg=90.0):
    phase = math.radians(phase_deg)
    return [
        (
            radius * math.cos(phase + 2 * math.pi * k / sides),
            radius * math.sin(phase + 2 * math.pi * k / sides),
        )
        for k in range(sides)
    ]


def transform(strokes, scale=1.0, angle_deg=0.0, dx=0.0, dy=0.0):
    """Scale, then rotate (counter-clockwise), then translate."""
    c, s = (
        math.cos(math.radians(angle_deg)) * scale,
        math.sin(math.radians(angle_deg)) * scale,
    )
    return [
        Stroke(
            [(x * c - y * s + dx, x * s + y * c + dy) for x, y in st.points], st.closed
        )
        for st in strokes
    ]


def segments(stroke):
    pts = stroke.points
    pairs = list(zip(pts, pts[1:]))
    if stroke.closed and len(pts) > 2:
        pairs.append((pts[-1], pts[0]))
    return pairs


def subdivide(strokes, max_len):
    """Insert vertices so no segment is longer than ``max_len`` (needed before distortion / per-vertex colour)."""
    out = []
    for st in strokes:
        if len(st.points) < 2:
            out.append(st)
            continue
        pts = []
        for (x0, y0), (x1, y1) in segments(st):
            n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / max_len))
            pts.extend(
                (x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n)
            )
        if not st.closed:
            pts.append(st.points[-1])
        out.append(Stroke(pts, st.closed))
    return out


def mirror(strokes, mode):
    """Add mirrored copies about the centre: ``h`` (left/right), ``v`` (up/down) or ``quad`` (both)."""
    if mode == "none":
        return strokes
    flips = {"h": [(-1, 1)], "v": [(1, -1)], "quad": [(-1, 1), (1, -1), (-1, -1)]}[mode]
    out = list(strokes)
    for fx, fy in flips:
        out.extend(
            Stroke([(x * fx, y * fy) for x, y in st.points], st.closed)
            for st in strokes
        )
    return out


def _clip_segment(x0, y0, x1, y1, lim=1.0):
    """Liang–Barsky clip of a segment to the square [-lim, lim]^2. Returns (t0, t1) or None."""
    t0, t1 = 0.0, 1.0
    dx, dy = x1 - x0, y1 - y0
    for p, q in ((-dx, x0 + lim), (dx, lim - x0), (-dy, y0 + lim), (dy, lim - y0)):
        if p == 0:
            if q < 0:
                return None
        else:
            t = q / p
            if p < 0:
                if t > t1:
                    return None
                t0 = max(t0, t)
            else:
                if t < t0:
                    return None
                t1 = min(t1, t)
    return t0, t1


def clip(strokes, lim=1.0):
    """Clip coloured strokes to the square [-lim, lim]^2, splitting them where they leave it."""
    out = []
    for st in strokes:
        pts = st.points
        if all(abs(p[0]) <= lim and abs(p[1]) <= lim for p in pts):
            out.append(st)
            continue
        if len(pts) == 1:
            continue
        chain = list(pts) + ([pts[0]] if st.closed else [])
        current = []
        for a, b in zip(chain, chain[1:]):
            hit = _clip_segment(a[0], a[1], b[0], b[1], lim)
            if hit is None:
                if current:
                    out.append(ColoredStroke(current, False))
                    current = []
                continue
            t0, t1 = hit
            start = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0) + tuple(
                a[2:]
            )
            end = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1) + tuple(a[2:])
            if t0 > 0 and current:
                out.append(ColoredStroke(current, False))
                current = []
            if not current:
                current = [start]
            current.append(end)
            if t1 < 1:
                out.append(ColoredStroke(current, False))
                current = []
        if len(current) > 1:
            out.append(ColoredStroke(current, False))
    return out


def stroke_length(stroke):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in segments(stroke))
