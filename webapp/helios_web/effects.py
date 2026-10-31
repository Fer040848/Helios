"""Scene composition: pattern -> motion effect -> transform -> mirror -> colour -> clip.

All time-dependent behaviour runs off ``Clocks``, which integrate their rates every frame so that moving a speed
slider changes the rate smoothly instead of making the image jump.
"""

import colorsys
import math

from . import patterns
from .geometry import (
    ColoredStroke,
    Stroke,
    clip,
    mirror,
    segments,
    stroke_length,
    subdivide,
    transform,
)

BEAT_PALETTE = [
    (1, 0, 0),
    (0, 1, 0),
    (0, 0.4, 1),
    (1, 1, 0),
    (0, 1, 1),
    (1, 0, 1),
    (1, 0.45, 0),
    (1, 1, 1),
]


class Clocks:
    """Running clocks: ``anim`` (× speed), ``effect`` (× effectSpeed, cycles), ``color`` (× colorSpeed),
    ``spin`` (degrees) and ``beats`` (× BPM / 60, always running)."""

    def __init__(self):
        self.anim = self.effect = self.color = self.spin = self.beats = 0.0

    def advance(self, dt, scene, bpm):
        self.anim += dt * scene["speed"]
        self.effect += dt * scene["effectSpeed"]
        self.color += dt * scene["colorSpeed"]
        self.spin = (self.spin + dt * scene["spin"]) % 360.0
        self.beats += dt * bpm / 60.0


def hex_to_rgb(color):
    return tuple(int(color[i : i + 2], 16) / 255.0 for i in (1, 3, 5))


def _effect_phase(scene, clocks):
    return (clocks.beats if scene["beatSync"] else clocks.effect) % 1.0


def _draw_on(strokes, fraction):
    """Keep the first ``fraction`` of the total path length."""
    total = sum(stroke_length(st) for st in strokes)
    budget = total * fraction
    out = []
    for st in strokes:
        if budget <= 0:
            break
        length = stroke_length(st)
        if length <= budget:
            out.append(st)
            budget -= length
            continue
        pts = [st.points[0]]
        for a, b in segments(st):
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            if seg >= budget:
                f = budget / seg if seg else 0.0
                pts.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
                break
            pts.append(b)
            budget -= seg
        out.append(Stroke(pts, False))
        break
    return out


def _colorize(strokes, scene, clocks):
    mode = scene["colorMode"]
    if mode == "solid":
        rgb = hex_to_rgb(scene["color"])
        return [
            ColoredStroke([p + rgb for p in st.points], st.closed) for st in strokes
        ]
    if mode == "cycle":
        h, _, _ = colorsys.rgb_to_hsv(*hex_to_rgb(scene["color"]))
        rgb = colorsys.hsv_to_rgb((h + clocks.color * 0.25) % 1.0, 1.0, 1.0)
        return [
            ColoredStroke([p + rgb for p in st.points], st.closed) for st in strokes
        ]
    if mode == "beat":
        rgb = BEAT_PALETTE[int(clocks.beats) % len(BEAT_PALETTE)]
        return [
            ColoredStroke([p + rgb for p in st.points], st.closed) for st in strokes
        ]
    # rainbow: hue runs once along the whole figure and drifts with the colour clock
    strokes = subdivide(strokes, 0.08)
    total = sum(stroke_length(st) for st in strokes) or 1.0
    out, travelled = [], 0.0
    for st in strokes:
        pts = []
        for i, p in enumerate(st.points):
            pts.append(
                p
                + colorsys.hsv_to_rgb(
                    (travelled / total + clocks.color * 0.5) % 1.0, 1.0, 1.0
                )
            )
            nxt = st.points[(i + 1) % len(st.points)]
            if i + 1 < len(st.points) or st.closed:
                travelled += math.hypot(nxt[0] - p[0], nxt[1] - p[1])
        out.append(ColoredStroke(pts, st.closed))
    return out


def compose(scene, clocks):
    """Render ``scene`` at the current clocks into coloured world-space strokes clipped to [-1, 1]."""
    size = scene["size"]
    strokes = patterns.generate(scene, clocks.anim, size)
    effect, amount, phase = (
        scene["effect"],
        scene["effectAmount"],
        _effect_phase(scene, clocks),
    )
    scale, angle, dx, dy = size, scene["rotation"] + clocks.spin, scene["x"], scene["y"]

    if effect == "pulse":
        scale *= 1 + 0.5 * amount * math.exp(-5 * phase)
    elif effect == "zoom":
        scale *= 1 - 0.8 * amount * (0.5 - 0.5 * math.cos(2 * math.pi * phase))
    elif effect == "orbit":
        dx += 0.5 * amount * math.cos(2 * math.pi * phase)
        dy += 0.5 * amount * math.sin(2 * math.pi * phase)
    elif effect == "bounce":
        dy += 0.6 * amount * (abs(math.sin(math.pi * phase)) - 0.5)
    elif effect == "wobble":
        angle += 45 * amount * math.sin(2 * math.pi * phase)
    elif effect == "strobe" and phase >= 1 - 0.85 * amount:
        return []

    strokes = transform(strokes, scale, angle, dx, dy)
    if effect == "wave":
        strokes = subdivide(strokes, 0.04)
        strokes = [
            Stroke(
                [
                    (x, y + 0.25 * amount * math.sin(2 * math.pi * (1.5 * x + phase)))
                    for x, y in st.points
                ],
                st.closed,
            )
            for st in strokes
        ]
    elif effect == "drawOn":
        strokes = _draw_on(strokes, min(1.0, phase * (1 + 2 * amount)))
    strokes = mirror(strokes, scene["mirror"])
    return clip(_colorize(strokes, scene, clocks))
