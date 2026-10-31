import ctypes
import tempfile
import unittest

from helios_web import model
from helios_web.engine import Engine
from helios_web.output import (
    AutoOutput,
    DacInfo,
    HeliosLibOutput,
    SimulatedOutput,
    to_highres,
    to_lowres,
)
from helios_web.store import Store


class FakeOutput:
    simulated = True
    max_points = 4095

    def __init__(self, dacs=2):
        self.n = dacs
        self.calls = []

    def open(self):
        return [DacInfo(i, f"DAC {i}", "sim") for i in range(self.n)]

    def write(self, index, points, pps):
        self.calls.append(("write", index, len(points)))

    def stop(self, index):
        self.calls.append(("stop", index))

    def shutter(self, index, is_open):
        self.calls.append(("shutter", index, is_open))

    def close(self):
        self.calls.append(("close",))

    def writes(self):
        return [c for c in self.calls if c[0] == "write"]


class FakeClock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make_engine(store=None, dacs=2):
    clock = FakeClock()
    out = FakeOutput(dacs)
    engine = Engine(out, store, clock=clock, sleep=clock.sleep)
    engine.open()
    return engine, out, clock


class SafetyEngineTests(unittest.TestCase):
    def test_starts_disarmed_and_writes_nothing(self):
        engine, out, _ = make_engine()
        self.assertFalse(engine.get_state()["armed"])
        for _ in range(5):
            engine.step()
        self.assertEqual(out.writes(), [])

    def test_armed_writes_every_dac(self):
        engine, out, _ = make_engine()
        engine.arm(True)
        engine.step()
        self.assertEqual({c[1] for c in out.writes()}, {0, 1})
        self.assertIn(("shutter", 0, True), out.calls)

    def test_blackout_stops_and_closes_shutters_then_no_writes(self):
        engine, out, _ = make_engine()
        engine.arm(True)
        engine.step()
        engine.blackout()
        for i in (0, 1):
            self.assertIn(("stop", i), out.calls)
            self.assertIn(("shutter", i, False), out.calls)
        before = len(out.writes())
        engine.step()
        self.assertEqual(len(out.writes()), before)
        self.assertFalse(engine.get_state()["armed"])

    def test_armed_flag_is_never_persisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine, _, _ = make_engine(Store(tmp))
            engine.arm(True)
            engine.update_settings({"brightness": 0.5})
            engine.flush()
            again, _, _ = make_engine(Store(tmp))
            self.assertFalse(again.armed)
            self.assertEqual(again.settings["brightness"], 0.5)

    def test_rescan_refused_while_armed(self):
        engine, _, _ = make_engine()
        engine.arm(True)
        with self.assertRaises(RuntimeError):
            engine.rescan()

    def test_shutdown_disarms_and_closes(self):
        engine, out, _ = make_engine()
        engine.arm(True)
        engine.shutdown()
        self.assertFalse(engine.armed)
        self.assertIn(("close",), out.calls)


class CueTests(unittest.TestCase):
    def test_trigger_save_clear_and_active_cue(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine, _, _ = make_engine(Store(tmp))
            self.assertTrue(engine.trigger_cue(1))
            self.assertEqual(engine.active_cue, 1)
            self.assertEqual(
                engine.scene["pattern"], engine.cues[1]["scene"]["pattern"]
            )
            engine.update_scene({"pattern": "heart", "color": "#ff0000"})
            self.assertIsNone(engine.active_cue)
            engine.save_cue(15, "Mi corazón")
            self.assertEqual(engine.cues[15]["scene"]["pattern"], "heart")
            self.assertTrue(engine.trigger_cue(15))
            engine.clear_cue(15)
            self.assertIsNone(engine.cues[15])
            self.assertIsNone(engine.active_cue)
            self.assertFalse(engine.trigger_cue(15))
            engine.flush()
            reloaded, _, _ = make_engine(Store(tmp))
            self.assertIsNone(reloaded.cues[15])
            self.assertEqual(reloaded.cues[1]["name"], engine.cues[1]["name"])

    def test_invalid_slot(self):
        engine, _, _ = make_engine()
        for bad in (-1, 16, "3", None, True):
            with self.assertRaises(ValueError):
                engine.trigger_cue(bad)

    def test_save_cue_name_is_trimmed(self):
        engine, _, _ = make_engine()
        engine.save_cue(12, "  " + "x" * 40)
        self.assertEqual(len(engine.cues[12]["name"]), model.MAX_CUE_NAME)
        engine.save_cue(13, "")
        self.assertEqual(engine.cues[13]["name"], "Cue 14")


class TempoTests(unittest.TestCase):
    def test_tap_tempo(self):
        engine, _, _ = make_engine()
        for i in range(5):
            engine.tap(now=10.0 + i * 0.5)
        self.assertAlmostEqual(engine.bpm, 120.0)
        engine.tap(now=20.0)  # > 2 s later: restart, BPM unchanged by a single tap
        self.assertAlmostEqual(engine.bpm, 120.0)
        engine.tap(now=20.4)
        self.assertAlmostEqual(engine.bpm, 150.0)

    def test_bpm_range(self):
        engine, _, _ = make_engine()
        engine.set_bpm(1000)
        self.assertEqual(engine.bpm, 240.0)
        with self.assertRaises(ValueError):
            engine.set_bpm("fast")


class FakeFn:
    def __init__(self, result=1, log=None, name=""):
        self.result, self.log, self.name = result, log, name

    def __call__(self, *args):
        self.log.append((self.name,) + args)
        return self.result() if callable(self.result) else self.result


class FakeLib:
    def __init__(self, highres=True, statuses=(1,)):
        self.log = []
        statuses = list(statuses)
        for name, result in (
            ("OpenDevices", 1),
            ("CloseDevices", 1),
            ("Stop", 1),
            ("SetShutter", 1),
            ("GetName", 1),
            ("WriteFrame", 1),
        ):
            setattr(self, name, FakeFn(result, self.log, name))
        self.GetStatus = FakeFn(
            lambda: statuses.pop(0) if statuses else 1, self.log, "GetStatus"
        )
        if highres:
            self.WriteFrameHighResolution = FakeFn(
                1, self.log, "WriteFrameHighResolution"
            )


class OutputTests(unittest.TestCase):
    def test_highres_preferred(self):
        lib = FakeLib(highres=True, statuses=(0, 0, 1))
        out = HeliosLibOutput(lib, sleep=lambda s: None)
        self.assertEqual(len(out.open()), 1)
        out.write(0, [(0.0, 0.0, 1.0, 0.0, 0.0)] * 300, 30000)
        names = [c[0] for c in lib.log]
        self.assertEqual(names.count("GetStatus"), 3)
        write = [c for c in lib.log if c[0] == "WriteFrameHighResolution"][0]
        self.assertEqual(write[2:4], (30000, 2))  # pps, HELIOS_FLAGS_SINGLE_MODE
        self.assertEqual(write[5], 300)

    def test_old_library_falls_back_to_writeframe(self):
        lib = FakeLib(highres=False)
        out = HeliosLibOutput(lib, sleep=lambda s: None)
        dacs = out.open()
        self.assertEqual(dacs[0].kind, "usb")
        out.write(0, [(0.0, 0.0, 1.0, 0.0, 0.0)] * 300, 30000)
        self.assertIn("WriteFrame", [c[0] for c in lib.log])

    def test_busy_dac_drops_the_frame(self):
        lib = FakeLib(statuses=[0] * 10000)
        clock = FakeClock()
        out = HeliosLibOutput(lib, sleep=clock.sleep, clock=clock)
        out.write(0, [(0.0, 0.0, 1.0, 0.0, 0.0)] * 300, 30000)
        self.assertNotIn("WriteFrameHighResolution", [c[0] for c in lib.log])

    def test_point_conversion(self):
        hi = to_highres([(-1.0, 1.0, 1.0, 0.5, 0.0)])[0]
        self.assertEqual((hi.x, hi.y, hi.r, hi.g, hi.b), (0, 0xFFFF, 0xFFFF, 0x8000, 0))
        lo = to_lowres([(1.0, -1.0, 0.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0, 0.0)])
        self.assertEqual((lo[0].x, lo[0].y, lo[0].i), (0xFFF, 0, 0))
        self.assertEqual((lo[1].g, lo[1].i), (255, 255))
        self.assertIsInstance(lo, ctypes.Array)

    def test_auto_output_falls_back_to_simulator(self):
        lib = FakeLib()
        lib.OpenDevices = FakeFn(0, lib.log, "OpenDevices")
        auto = AutoOutput(HeliosLibOutput(lib))
        dacs = auto.open()
        self.assertTrue(auto.simulated)
        self.assertEqual(dacs[0].kind, "sim")

    def test_simulator_paces_by_frame_duration(self):
        clock = FakeClock()
        sim = SimulatedOutput(clock=clock, sleep=clock.sleep)
        start = clock.t
        for _ in range(11):
            sim.write(0, [(0, 0, 0, 0, 0)] * 300, 30000)
        self.assertAlmostEqual(clock.t - start, 10 * 300 / 30000)


if __name__ == "__main__":
    unittest.main()
