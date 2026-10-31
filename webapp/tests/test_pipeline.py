import math
import unittest

from helios_web import font, model
from helios_web.effects import Clocks, compose
from helios_web.geometry import ColoredStroke, Stroke, clip
from helios_web.patterns import GENERATORS
from helios_web.rasterize import (
    BEAM_SAFETY_EXTENT,
    MAX_POINTS,
    beam_safe,
    build_frame,
    rasterize,
)

SETTINGS = dict(model.SETTINGS_DEFAULTS)


def scene(**kw):
    return model.merge_scene(model.SCENE_DEFAULTS, kw)


def lit(points):
    return [p for p in points if p[2] > 0 or p[3] > 0 or p[4] > 0]


class PatternTests(unittest.TestCase):
    def test_registry_matches_contract(self):
        self.assertEqual(set(GENERATORS), set(model.PATTERNS))

    def test_every_pattern_renders_inside_range(self):
        drawing = [[[-0.5, -0.5], [0.5, 0.5], [0.5, -0.5]]]
        for pid in model.PATTERNS:
            for t in (0.0, 0.7, 3.3, 11.0):
                sc = scene(
                    pattern=pid,
                    drawing=drawing,
                    size=1.0,
                    textMode="scroll" if t > 1 else "static",
                )
                clocks = Clocks()
                clocks.anim = clocks.effect = clocks.color = clocks.beats = t
                strokes = compose(sc, clocks)
                self.assertTrue(
                    strokes or (pid == "text" and t > 1), f"{pid} at t={t} drew nothing"
                )
                for st in strokes:
                    for x, y, r, g, b in st.points:
                        self.assertTrue(-1 <= x <= 1 and -1 <= y <= 1, (pid, t, x, y))
                        self.assertTrue(all(0 <= c <= 1 for c in (r, g, b)))

    def test_every_effect_and_colour_mode_renders(self):
        for effect in model.EFFECTS:
            for mode in model.COLOR_MODES:
                clocks = Clocks()
                clocks.effect = clocks.beats = 0.1
                strokes = compose(
                    scene(pattern="star", effect=effect, colorMode=mode), clocks
                )
                self.assertTrue(strokes, (effect, mode))

    def test_strobe_blanks_part_of_the_cycle(self):
        clocks = Clocks()
        clocks.effect = 0.9
        self.assertEqual(compose(scene(effect="strobe", effectAmount=1.0), clocks), [])

    def test_drawing_maps_one_to_one_whatever_the_size(self):
        for size in (0.3, 0.6, 1.0):
            (st,) = compose(
                scene(
                    pattern="drawing", size=size, drawing=[[[0.5, 0.5], [-0.25, 0.75]]]
                ),
                Clocks(),
            )
            self.assertAlmostEqual(st.points[0][0], 0.5)
            self.assertAlmostEqual(st.points[1][1], 0.75)

    def test_mirror_quad_makes_four_copies(self):
        self.assertEqual(
            len(compose(scene(pattern="circle", x=0.3, mirror="quad"), Clocks())), 4
        )


class FontTests(unittest.TestCase):
    def test_required_characters(self):
        for char in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-:+/ÑÁÉÍÓÚ":
            self.assertTrue(font.supported(char), char)

    def test_lowercase_and_spanish_input(self):
        lines_lower, width_lower = font.layout("mañana")
        lines_upper, width_upper = font.layout("MAÑANA")
        self.assertEqual(lines_lower, lines_upper)
        self.assertEqual(width_lower, width_upper)
        self.assertGreater(width_upper, 0)

    def test_scrolling_text_moves(self):
        a, b = Clocks(), Clocks()
        b.anim = 1.0
        sa = compose(scene(pattern="text", text="HOLA", textMode="scroll"), a)
        sb = compose(scene(pattern="text", text="HOLA", textMode="scroll"), b)
        self.assertNotEqual(sa, sb)


class ModelTests(unittest.TestCase):
    def test_clamps_ignores_unknown_and_invalid(self):
        sc = model.merge_scene(
            model.SCENE_DEFAULTS,
            {
                "size": 7,
                "x": -3,
                "spin": float("nan"),
                "pattern": "nope",
                "effect": "pulse",
                "color": "red",
                "beatSync": "yes",
                "bogus": 1,
                "text": "x" * 100,
            },
        )
        self.assertEqual(sc["size"], 1.0)
        self.assertEqual(sc["x"], -1.0)
        self.assertEqual(sc["spin"], 0.0)
        self.assertEqual(sc["pattern"], "circle")
        self.assertEqual(sc["effect"], "pulse")
        self.assertEqual(sc["color"], "#00ff00")
        self.assertFalse(sc["beatSync"])
        self.assertNotIn("bogus", sc)
        self.assertEqual(len(sc["text"]), model.MAX_TEXT)

    def test_drawing_is_cleaned_and_truncated(self):
        big = [
            [[0.1, 0.1]] * 1500,
            [[2, -2], ["a", 0], [0.5, 0.5]],
            "junk",
            [[0, 0]] * 1500,
        ]
        drawing = model.merge_scene(model.SCENE_DEFAULTS, {"drawing": big})["drawing"]
        self.assertEqual(sum(len(s) for s in drawing), model.MAX_DRAWING_POINTS)
        self.assertEqual(drawing[1][0], [1.0, -1.0])

    def test_settings_ranges(self):
        st = model.merge_settings(
            model.SETTINGS_DEFAULTS, {"pps": 99999.7, "brightness": -1, "invertX": 1}
        )
        self.assertEqual(st["pps"], 65535)
        self.assertEqual(st["brightness"], 0.0)
        self.assertFalse(st["invertX"])

    def test_default_cues(self):
        cues = model.default_cues()
        self.assertEqual(len(cues), model.CUE_SLOTS)
        self.assertGreaterEqual(sum(c is not None for c in cues), 10)


class GeometryTests(unittest.TestCase):
    def test_clip_splits_strokes_leaving_the_box(self):
        st = ColoredStroke([(-2.0, 0.0, 1, 0, 0), (2.0, 0.0, 1, 0, 0)], False)
        (out,) = clip([st])
        self.assertAlmostEqual(out.points[0][0], -1.0)
        self.assertAlmostEqual(out.points[-1][0], 1.0)

    def test_clip_keeps_vertex_colours(self):
        st = ColoredStroke(
            [(-2.0, 0.0, 1, 0, 0), (0.0, 0.0, 0, 1, 0), (0.5, 0.0, 0, 0, 1)], False
        )
        (out,) = clip([st])
        self.assertEqual(out.points[1][2:], (0, 1, 0))


class RasterTests(unittest.TestCase):
    def colored(self, pts, closed=False, rgb=(1, 1, 1)):
        return ColoredStroke([p + rgb for p in pts], closed)

    def test_blanks_between_strokes(self):
        a = self.colored([(-0.8, 0.0), (-0.4, 0.0)])
        b = self.colored([(0.4, 0.0), (0.8, 0.0)])
        points = rasterize([a, b], 30000)
        gap = [p for p in points if -0.35 < p[0] < 0.35]
        self.assertTrue(gap)
        self.assertTrue(
            all(p[2:] == (0, 0, 0) for p in gap), "jump between strokes must be blanked"
        )

    def test_min_and_max_points(self):
        tiny = rasterize([self.colored([(0.0, 0.0), (0.1, 0.0)])], 30000)
        self.assertGreaterEqual(len(tiny), 360)
        many = [self.colored([(-1.0, y / 50), (1.0, y / 50)]) for y in range(-50, 50)]
        self.assertLessEqual(len(rasterize(many, 30000)), MAX_POINTS)

    def test_closed_shape_loops_without_blanking(self):
        circle = self.colored(
            [(math.cos(a / 10), math.sin(a / 10)) for a in range(63)], closed=True
        )
        self.assertEqual(
            len(lit(rasterize([circle], 30000))), len(rasterize([circle], 30000))
        )

    def test_empty_frame_is_blank(self):
        points = rasterize([], 30000)
        self.assertTrue(points and not lit(points))


class SafetyTests(unittest.TestCase):
    def test_brightness_scales_colours(self):
        _, points = build_frame(
            compose(scene(color="#ffffff"), Clocks()), dict(SETTINGS, brightness=0.25)
        )
        self.assertAlmostEqual(max(p[2] for p in points), 0.25)

    def test_scan_size_limits_and_clamps(self):
        world = [ColoredStroke([(-1.0, -1.0, 1, 1, 1), (1.0, 1.0, 1, 1, 1)], False)]
        _, points = build_frame(world, dict(SETTINGS, scanSize=0.5))
        self.assertLessEqual(max(abs(p[0]) for p in points), 0.5 + 1e-9)
        self.assertLessEqual(max(abs(p[1]) for p in points), 0.5 + 1e-9)

    def test_invert_and_swap(self):
        world = [ColoredStroke([(0.5, 0.2, 1, 1, 1)], False)]
        strokes, _ = build_frame(
            world,
            dict(SETTINGS, scanSize=1.0, swapXY=True, invertX=True, beamSafety=False),
        )
        self.assertEqual(strokes[0].points[0][:2], (-0.2, 0.5))

    def test_every_dac_frame_ends_blanked(self):
        for world in (compose(scene(pattern="circle"), Clocks()), compose(scene(pattern="star", size=1.0), Clocks())):
            _, points = build_frame(world, SETTINGS)
            self.assertFalse(lit(points[-1:]), "a frame must never end on a lit point")
        many = [ColoredStroke([(-1.0, y / 50, 1, 1, 1), (1.0, y / 50, 1, 1, 1)], False) for y in range(-50, 50)]
        _, points = build_frame(many, dict(SETTINGS, scanSize=1.0))
        self.assertLessEqual(len(points), MAX_POINTS)
        self.assertFalse(lit(points[-1:]), "a truncated frame must end blanked")

    def test_beam_safety_blanks_a_single_dot(self):
        dot = [ColoredStroke([(0.1, 0.1, 1, 1, 1)], False)]
        preview, points = build_frame(dot, SETTINGS)
        self.assertEqual(preview, [])
        self.assertEqual(lit(points), [])

    def test_beam_safety_blanks_a_collapsed_shape(self):
        _, points = build_frame(compose(scene(size=0.0), Clocks()), SETTINGS)
        self.assertEqual(lit(points), [])

    def test_beam_safety_can_be_disabled(self):
        dot = [ColoredStroke([(0.1, 0.1, 1, 1, 1)], False)]
        _, points = build_frame(dot, dict(SETTINGS, beamSafety=False))
        self.assertTrue(lit(points))

    def test_beam_safety_allows_lines_and_spread_beams(self):
        _, points = build_frame(compose(scene(pattern="line"), Clocks()), SETTINGS)
        self.assertTrue(lit(points))
        _, points = build_frame(compose(scene(pattern="fan"), Clocks()), SETTINGS)
        self.assertTrue(lit(points))
        self.assertTrue(beam_safe([(0, 0, 1, 1, 1), (BEAM_SAFETY_EXTENT, 0, 1, 1, 1)]))


if __name__ == "__main__":
    unittest.main()
