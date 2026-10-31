"""Emit Python-engine reference frames as JSON for the JavaScript parity test (tests/js/engine.test.mjs).

Uses only the core engine modules (no aiohttp), so any Python 3.9+ can run it: python3 tests/js/make_parity.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from helios_web import model  # noqa: E402
from helios_web.effects import Clocks, compose  # noqa: E402
from helios_web.rasterize import build_frame  # noqa: E402

VARIANTS = (("none", "solid", "none"), ("wave", "rainbow", "quad"), ("pulse", "cycle", "h"),
            ("drawOn", "beat", "none"), ("orbit", "rainbow", "v"))

cases = []
for pid in model.PATTERNS:
    for effect, mode, mirror in VARIANTS:
        for t in (1.3, 4.1):
            scene = model.merge_scene(model.SCENE_DEFAULTS, {
                "pattern": pid, "effect": effect, "colorMode": mode, "mirror": mirror, "spin": 30, "x": 0.2,
                "textMode": "scroll" if effect == "wave" else "static",
                "drawing": [[[0, 0], [0.5, 0.5], [0.5, -0.2]]]})
            clocks = Clocks()
            clocks.anim, clocks.effect, clocks.color, clocks.spin, clocks.beats = t, 0.37 * t, 0.8, 12.0 * t, 5.25 * t
            settings = dict(model.SETTINGS_DEFAULTS, invertX=True)
            preview, points = build_frame(compose(scene, clocks), settings)
            cases.append({"scene": scene, "clocks": vars(clocks), "settings": settings, "points": points,
                          "preview": len(preview)})
json.dump(cases, sys.stdout)
