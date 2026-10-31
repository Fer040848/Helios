"""Coloured strokes -> galvo-friendly point stream, plus the output-side safety stages.

Defaults (normalised units, full scan range = 2.0):
  lit step    = LIT_RATE / pps   (0.015 at 30 kpps: ~133 points across the full width)
  blank step  = 2 × lit step     (blanked moves can travel faster)
  dwell       = 4 blanked points at a jump target, 2 lit at a stroke start, 3 lit at a stroke end and at corners
                sharper than 45°; jump dwells are skipped where strokes already join, so a single closed shape
                loops seamlessly. A one-vertex stroke (a beam) gets BEAM_DWELL lit points.
  frame size  = at least max(200, pps × 0.012) points (padded by repeating the whole, cyclic frame) and at most
                ``max_points`` (re-rasterised coarser, then truncated as a last resort).
"""

import math

from .geometry import ColoredStroke

LIT_RATE = 450.0
BLANK_DWELL = 4
START_DWELL = 2
END_DWELL = 3
CORNER_DWELL = 3
CORNER_ANGLE = math.radians(45)
BEAM_DWELL = 8
MIN_FRAME_SECONDS = 0.012
MIN_POINTS = 200
MAX_POINTS = 4095
BEAM_SAFETY_EXTENT = 0.05
TAIL_BLANK = 4  # blanked points closing every DAC frame
_JOIN_EPS = 1e-4

BLANK = (0.0, 0.0, 0.0)


def _steps(x):
    """ceil() that ignores float noise, so a length that is an exact multiple of the step (up to rounding) gives the
    same point count in this engine and in the JavaScript port (static/engine/rasterize.js)."""
    return math.ceil(x - 1e-9)


def output_transform(strokes, settings):
    """Apply scan size, swap and invert (in that order), then clamp to [-1, 1]."""
    k = settings["scanSize"]
    swap, ix, iy = settings["swapXY"], settings["invertX"], settings["invertY"]
    out = []
    for st in strokes:
        pts = []
        for x, y, r, g, b in st.points:
            x, y = x * k, y * k
            if swap:
                x, y = y, x
            if ix:
                x = -x
            if iy:
                y = -y
            pts.append((min(1.0, max(-1.0, x)), min(1.0, max(-1.0, y)), r, g, b))
        out.append(ColoredStroke(pts, st.closed))
    return out


def _corner(prev, cur, nxt):
    ax, ay, bx, by = (
        cur[0] - prev[0],
        cur[1] - prev[1],
        nxt[0] - cur[0],
        nxt[1] - cur[1],
    )
    la, lb = math.hypot(ax, ay), math.hypot(bx, by)
    if la < _JOIN_EPS or lb < _JOIN_EPS:
        return False
    cos = max(-1.0, min(1.0, (ax * bx + ay * by) / (la * lb)))
    return math.acos(cos) > CORNER_ANGLE + 1e-9  # exact 45-degree turns are not corners (no float noise)


def _rasterize_once(strokes, lit_step, blank_step):
    points = []
    if not strokes:
        return points
    last = strokes[-1].points[0] if strokes[-1].closed else strokes[-1].points[-1]
    pos = (last[0], last[1])
    for idx, st in enumerate(strokes):
        pts = st.points
        start = pts[0]
        jump = math.hypot(start[0] - pos[0], start[1] - pos[1]) > _JOIN_EPS
        if jump:
            n = max(
                1,
                _steps(
                    math.hypot(start[0] - pos[0], start[1] - pos[1]) / blank_step
                ),
            )
            for k in range(1, n + 1):
                points.append(
                    (
                        pos[0] + (start[0] - pos[0]) * k / n,
                        pos[1] + (start[1] - pos[1]) * k / n,
                    )
                    + BLANK
                )
            points.extend([(start[0], start[1]) + BLANK] * BLANK_DWELL)
        if len(pts) == 1:
            points.extend([tuple(start)] * BEAM_DWELL)
            pos = (start[0], start[1])
            continue
        if jump:
            points.extend([tuple(start)] * START_DWELL)
        chain = list(pts) + ([pts[0]] if st.closed else [])
        for i, (a, b) in enumerate(zip(chain, chain[1:])):
            n = max(1, _steps(math.hypot(b[0] - a[0], b[1] - a[1]) / lit_step))
            color = tuple(a[2:5])
            for k in range(1, n + 1):
                points.append(
                    (a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) + color
                )
            following = (
                chain[i + 2]
                if i + 2 < len(chain)
                else (chain[1] if st.closed else None)
            )
            if following is not None and _corner(a, b, following):
                points.extend([(b[0], b[1]) + color] * CORNER_DWELL)
        end = chain[-1]
        nxt = strokes[(idx + 1) % len(strokes)].points[0]
        if math.hypot(nxt[0] - end[0], nxt[1] - end[1]) > _JOIN_EPS:
            points.extend([points[-1]] * END_DWELL)
        pos = (end[0], end[1])
    return points


def rasterize(strokes, pps, max_points=MAX_POINTS):
    """Turn coloured strokes into a list of ``(x, y, r, g, b)`` points for one frame."""
    min_points = min(max_points, max(MIN_POINTS, int(pps * MIN_FRAME_SECONDS)))
    lit_step = LIT_RATE / pps
    points = _rasterize_once(strokes, lit_step, 2 * lit_step)
    for _ in range(4):
        if len(points) <= max_points:
            break
        lit_step *= 1.15 * len(points) / max_points
        points = _rasterize_once(strokes, lit_step, 2 * lit_step)
    points = points[:max_points]
    if not points:
        return [(0.0, 0.0) + BLANK] * min_points
    if len(points) < min_points:
        points = points * _steps(min_points / len(points))
    return points


def is_lit(p):
    return p[2] > 0 or p[3] > 0 or p[4] > 0


def beam_safe(points):
    """False when every lit point sits inside a box smaller than BEAM_SAFETY_EXTENT in both directions."""
    lit = [p for p in points if is_lit(p)]
    if not lit:
        return True
    xs, ys = [p[0] for p in lit], [p[1] for p in lit]
    return (max(xs) - min(xs)) >= BEAM_SAFETY_EXTENT or (
        max(ys) - min(ys)
    ) >= BEAM_SAFETY_EXTENT


def blank(points):
    return [(p[0], p[1]) + BLANK for p in points]


def apply_brightness(points, brightness):
    return [
        (x, y, r * brightness, g * brightness, b * brightness)
        for x, y, r, g, b in points
    ]


def build_frame(world_strokes, settings, max_points=MAX_POINTS):
    """Full output stage. Returns ``(preview_strokes, points)``.

    ``preview_strokes`` are after the output transform with colours before brightness (empty when beam safety
    blanks the frame); ``points`` are what goes to the DAC.
    """
    strokes = output_transform(world_strokes, settings)
    points = rasterize(strokes, settings["pps"], max_points - TAIL_BLANK)
    # Always end dark: if the DAC holds its last sample when the next frame is late, it holds a blanked point,
    # never a stationary lit beam (this also covers a frame truncated mid-stroke).
    x, y = points[-1][0], points[-1][1]
    points = points + [(x, y) + BLANK] * TAIL_BLANK
    if settings["beamSafety"] and not beam_safe(points):
        return [], blank(points)
    return strokes, apply_brightness(points, settings["brightness"])
