"""Scene / settings schema: defaults, validation and the default cue set.

Every client update goes through ``merge_scene`` / ``merge_settings``: numbers are clamped to range,
enum values must be known, unknown keys are ignored. The result is always a complete, valid dict.
"""

import copy
import math
import re

PATTERNS = {
    "circle": "Círculo",
    "square": "Cuadrado",
    "triangle": "Triángulo",
    "star": "Estrella",
    "heart": "Corazón",
    "line": "Línea",
    "spiral": "Espiral",
    "wave": "Onda",
    "lissajous": "Lissajous",
    "tunnel": "Túnel",
    "fan": "Abanico",
    "grid": "Rejilla",
    "flower": "Flor",
    "text": "Texto",
    "drawing": "Dibujo",
}
EFFECTS = {
    "none": "Ninguno",
    "pulse": "Pulso",
    "wave": "Ondulación",
    "orbit": "Órbita",
    "bounce": "Rebote",
    "zoom": "Zoom",
    "strobe": "Estrobo",
    "wobble": "Vaivén",
    "drawOn": "Trazado",
}
COLOR_MODES = {
    "solid": "Sólido",
    "rainbow": "Arcoíris",
    "cycle": "Ciclo",
    "beat": "Al ritmo",
}
MIRRORS = ("none", "h", "v", "quad")
TEXT_MODES = ("static", "scroll")

MAX_TEXT = 64
MAX_CUE_NAME = 24
MAX_DRAWING_POINTS = 2000
CUE_SLOTS = 16
BPM_RANGE = (40.0, 240.0)

SCENE_DEFAULTS = {
    "pattern": "circle",
    "text": "HOLA",
    "textMode": "static",
    "drawing": [],
    "size": 0.6,
    "x": 0.0,
    "y": 0.0,
    "rotation": 0.0,
    "spin": 0.0,
    "speed": 1.0,
    "color": "#00ff00",
    "colorMode": "solid",
    "colorSpeed": 0.5,
    "effect": "none",
    "effectAmount": 0.5,
    "effectSpeed": 0.5,
    "beatSync": False,
    "mirror": "none",
}
SETTINGS_DEFAULTS = {
    "pps": 30000,
    "brightness": 0.3,
    "scanSize": 0.8,
    "invertX": False,
    "invertY": False,
    "swapXY": False,
    "beamSafety": True,
}

_SCENE_NUMBERS = {
    "size": (0.0, 1.0),
    "x": (-1.0, 1.0),
    "y": (-1.0, 1.0),
    "rotation": (-180.0, 180.0),
    "spin": (-360.0, 360.0),
    "speed": (0.0, 2.0),
    "colorSpeed": (0.0, 2.0),
    "effectAmount": (0.0, 1.0),
    "effectSpeed": (0.0, 2.0),
}
_SCENE_ENUMS = {
    "pattern": PATTERNS,
    "textMode": TEXT_MODES,
    "colorMode": COLOR_MODES,
    "effect": EFFECTS,
    "mirror": MIRRORS,
}
_SETTINGS_NUMBERS = {
    "pps": (1000, 65535),
    "brightness": (0.0, 1.0),
    "scanSize": (0.1, 1.0),
}
_SETTINGS_BOOLS = ("invertX", "invertY", "swapXY", "beamSafety")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def clamp_number(value, lo, hi):
    """Return ``value`` clamped to [lo, hi], or None when it is not a finite number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)          # a huge JSON integer overflows here instead of being finite
    except OverflowError:
        return None
    if not math.isfinite(number):
        return None
    return min(hi, max(lo, number))


def well_formed(text):
    """Lone UTF-16 surrogates (valid in JSON, not in UTF-8) become '?', so state always encodes."""
    return text.encode("utf-8", "replace").decode("utf-8")


def _clean_drawing(value):
    if not isinstance(value, list):
        return None
    strokes, budget = [], MAX_DRAWING_POINTS
    for stroke in value:
        if not isinstance(stroke, list) or budget <= 0:
            continue
        points = []
        for p in stroke[:budget]:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                x, y = clamp_number(p[0], -1.0, 1.0), clamp_number(p[1], -1.0, 1.0)
                if x is not None and y is not None:
                    points.append([round(x, 4), round(y, 4)])
        if points:
            strokes.append(points)
            budget -= len(points)
    return strokes


def merge_scene(base, partial):
    """Return a new complete scene: ``base`` with the valid fields of ``partial`` applied."""
    scene = copy.deepcopy(base)
    if not isinstance(partial, dict):
        return scene
    for key, value in partial.items():
        if key in _SCENE_NUMBERS:
            number = clamp_number(value, *_SCENE_NUMBERS[key])
            if number is not None:
                scene[key] = number
        elif key in _SCENE_ENUMS:
            if isinstance(value, str) and value in _SCENE_ENUMS[key]:
                scene[key] = value
        elif key == "text":
            if isinstance(value, str):
                scene["text"] = well_formed(value[:MAX_TEXT])
        elif key == "color":
            if isinstance(value, str) and _COLOR_RE.fullmatch(value):
                scene["color"] = value.lower()
        elif key == "beatSync":
            if isinstance(value, bool):
                scene["beatSync"] = value
        elif key == "drawing":
            drawing = _clean_drawing(value)
            if drawing is not None:
                scene["drawing"] = drawing
    return scene


def merge_settings(base, partial):
    """Return new complete settings: ``base`` with the valid fields of ``partial`` applied."""
    settings = dict(base)
    if not isinstance(partial, dict):
        return settings
    for key, value in partial.items():
        if key in _SETTINGS_NUMBERS:
            number = clamp_number(value, *_SETTINGS_NUMBERS[key])
            if number is not None:
                settings[key] = int(round(number)) if key == "pps" else number
        elif key in _SETTINGS_BOOLS and isinstance(value, bool):
            settings[key] = value
    return settings


def default_scene():
    return copy.deepcopy(SCENE_DEFAULTS)


def clean_cue(cue):
    """Validate a stored cue; returns None for empty or malformed slots."""
    if not isinstance(cue, dict) or not isinstance(cue.get("name"), str):
        return None
    return {
        "name": well_formed(cue["name"][:MAX_CUE_NAME]),
        "scene": merge_scene(SCENE_DEFAULTS, cue.get("scene")),
    }


def clean_cues(cues):
    cues = cues if isinstance(cues, list) else []
    cleaned = [clean_cue(c) for c in cues[:CUE_SLOTS]]
    return cleaned + [None] * (CUE_SLOTS - len(cleaned))


_DEFAULT_CUES = [
    ("Círculo verde", {"pattern": "circle", "color": "#00ff00"}),
    ("Túnel arcoíris", {"pattern": "tunnel", "colorMode": "rainbow"}),
    ("Estrella giratoria", {"pattern": "star", "color": "#ffff00", "spin": 90}),
    ("Onda azul", {"pattern": "wave", "color": "#0088ff"}),
    (
        "Texto HOLA",
        {"pattern": "text", "text": "HOLA", "textMode": "scroll", "color": "#ff00ff"},
    ),
    ("Abanico", {"pattern": "fan", "color": "#00ffff"}),
    ("Lissajous", {"pattern": "lissajous", "colorMode": "cycle"}),
    (
        "Corazón",
        {"pattern": "heart", "color": "#ff0000", "effect": "pulse", "beatSync": True},
    ),
    ("Rejilla", {"pattern": "grid", "color": "#00ff00", "effect": "wave"}),
    ("Espiral", {"pattern": "spiral", "colorMode": "rainbow", "spin": 60}),
]


def default_cues():
    return clean_cues([{"name": name, "scene": scene} for name, scene in _DEFAULT_CUES])


def catalog():
    """The id/name lists the UI renders."""

    def entries(names):
        return [{"id": k, "name": v} for k, v in names.items()]

    return {
        "patterns": entries(PATTERNS),
        "effects": entries(EFFECTS),
        "colorModes": entries(COLOR_MODES),
    }
