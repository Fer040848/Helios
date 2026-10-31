"""Show state, cues and the render loop.

Threading: the render loop runs in its own daemon thread because DAC calls block. ``_lock`` guards the show state;
``_out_lock`` serialises DAC access. Lock order is always ``_out_lock`` before ``_lock``. The writer re-checks
``armed`` inside ``_out_lock``, and disarming clears ``armed`` before stopping the DACs under ``_out_lock``, so once
``disarm`` returns no further frame can reach a DAC.
Every state change bumps ``version``; the server polls it to know when to broadcast.
"""

import copy
import logging
import threading
import time

from . import model
from .effects import Clocks, compose
from .rasterize import build_frame

log = logging.getLogger(__name__)

IDLE_FPS = 30.0  # render rate while disarmed (preview only)
MAX_DT = 0.1  # clamp clock steps after stalls
PERSIST_INTERVAL = 1.0  # seconds between writes of dirty settings / cues
TAP_RESET = 2.0  # seconds between taps that restart tap tempo
TAP_WINDOW = 4  # intervals averaged


class Engine:
    def __init__(self, output, store=None, clock=time.monotonic, sleep=time.sleep):
        self.output, self.store, self._clock, self._sleep = output, store, clock, sleep
        self._lock = threading.RLock()
        self._out_lock = threading.Lock()
        saved = store.load() if store else {}
        self.scene = model.default_scene()
        self.settings = model.merge_settings(
            model.SETTINGS_DEFAULTS, saved.get("settings")
        )
        self.cues = (
            model.clean_cues(saved["cues"]) if "cues" in saved else model.default_cues()
        )
        self.armed = False
        self.active_cue = None
        self.bpm = 120.0
        self.dacs = []
        self.version = 0
        self.fps = 0.0
        self.points = 0
        self._taps = []
        self._clocks = Clocks()
        self._preview = []
        self._last_tick = None
        self._avg_dt = 0.0
        self._dirty = False
        self._persist_lock = threading.Lock()
        self._stop_persist = threading.Event()
        self._thread = None
        self._running = False
        self._last_error_log = 0.0

    # ----- state -------------------------------------------------------------------------------------------
    def _changed(self, persist=False):
        self.version += 1
        if persist:
            self._dirty = True

    def get_state(self):
        with self._lock:
            state = {
                "armed": self.armed,
                "simulated": self.output.simulated,
                "dacs": [d.as_dict() for d in self.dacs],
                "scene": copy.deepcopy(self.scene),
                "settings": dict(self.settings),
                "cues": copy.deepcopy(self.cues),
                "activeCue": self.active_cue,
                "bpm": round(self.bpm, 1),
            }
        state.update(model.catalog())
        return state

    def update_scene(self, partial):
        with self._lock:
            self.scene = model.merge_scene(self.scene, partial)
            self.active_cue = None
            self._changed()

    def update_settings(self, partial):
        with self._lock:
            self.settings = model.merge_settings(self.settings, partial)
            self._changed(persist=True)

    def _check_slot(self, index):
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or not 0 <= index < model.CUE_SLOTS
        ):
            raise ValueError("Cue inválido")

    def trigger_cue(self, index):
        self._check_slot(index)
        with self._lock:
            cue = self.cues[index]
            if cue is None:
                return False
            self.scene = model.merge_scene(model.SCENE_DEFAULTS, cue["scene"])
            self.active_cue = index
            self._changed()
            return True

    def save_cue(self, index, name):
        self._check_slot(index)
        name = model.well_formed((name if isinstance(name, str) else "").strip()[: model.MAX_CUE_NAME])
        name = name or f"Cue {index + 1}"
        with self._lock:
            self.cues[index] = {"name": name, "scene": copy.deepcopy(self.scene)}
            self._changed(persist=True)

    def clear_cue(self, index):
        self._check_slot(index)
        with self._lock:
            self.cues[index] = None
            if self.active_cue == index:
                self.active_cue = None
            self._changed(persist=True)

    def set_bpm(self, bpm):
        value = model.clamp_number(bpm, *model.BPM_RANGE)
        if value is None:
            raise ValueError("BPM inválido")
        with self._lock:
            self.bpm = value
            self._changed()

    def tap(self, now=None):
        now = self._clock() if now is None else now
        with self._lock:
            if self._taps and now - self._taps[-1] > TAP_RESET:
                self._taps = []
            self._taps = (self._taps + [now])[-(TAP_WINDOW + 1) :]
            if len(self._taps) >= 2:
                intervals = [b - a for a, b in zip(self._taps, self._taps[1:])]
                mean = sum(intervals) / len(intervals)
                if mean > 0:
                    self.bpm = min(
                        model.BPM_RANGE[1], max(model.BPM_RANGE[0], 60.0 / mean)
                    )
                    self._clocks.beats = (
                        float(int(self._clocks.beats)) + 0.999
                    )  # next frame starts a beat
            self._changed()

    # ----- output control ----------------------------------------------------------------------------------
    def open(self):
        with self._out_lock:
            self._open_locked()

    def _open_locked(self):
        dacs = self.output.open()
        with self._lock:
            self.dacs = dacs
            self._changed()

    def arm(self, armed):
        if not armed:
            self.disarm()
            return
        with self._out_lock:
            with self._lock:
                if self.armed:
                    return
                self.armed = True
                self._changed()
            for dac in self.dacs:
                self._safe(self.output.shutter, dac.index, True)

    def disarm(self):
        # Fast path: the render loop stops sending at its next frame even while a write holds _out_lock.
        with self._lock:
            self.armed = False
            self._changed()
        with self._out_lock:
            self._disarm_locked()

    def _disarm_locked(self):
        # Cleared again under _out_lock: an arm() that slipped in since the fast path cannot outlive this blackout.
        with self._lock:
            self.armed = False
            self._changed()
        for dac in self.dacs:
            self._safe(self.output.stop, dac.index)
            self._safe(self.output.shutter, dac.index, False)

    blackout = disarm

    def rescan(self):
        """Re-open the DACs. Holds _out_lock throughout, so arm() cannot interleave with the swap."""
        with self._out_lock:
            if self.armed:
                raise RuntimeError("Apaga la salida antes de buscar DACs")
            self._disarm_locked()
            self._safe(self.output.close)
            self._open_locked()

    def _safe(self, fn, *args):
        try:
            fn(*args)
        except Exception:
            log.exception("Error del DAC")

    # ----- rendering ---------------------------------------------------------------------------------------
    def frame_snapshot(self):
        with self._lock:
            return self._preview, self.fps, self.points

    def render(self, dt):
        """Advance the clocks by ``dt`` and build one frame. Returns the DAC points."""
        with self._lock:
            scene, settings, bpm = self.scene, dict(self.settings), self.bpm
            self._clocks.advance(min(max(dt, 0.0), MAX_DT), scene, bpm)
            clocks = copy.copy(self._clocks)
        preview, points = build_frame(
            compose(scene, clocks), settings, self.output.max_points
        )
        with self._lock:
            self._preview, self.points = preview, len(points)
        return points, settings["pps"]

    def step(self):
        """One loop iteration: render, write when armed, pace, persist."""
        now = self._clock()
        dt = 0.0 if self._last_tick is None else now - self._last_tick
        if (
            dt > 0
        ):  # average the period, not the rate, so one short step can't spike the reading
            self._avg_dt = 0.9 * self._avg_dt + 0.1 * dt if self._avg_dt else dt
            self.fps = 1.0 / self._avg_dt
        self._last_tick = now
        points, pps = self.render(dt)
        wrote = False
        with self._out_lock:
            if self.armed:
                for dac in self.dacs:
                    try:
                        self.output.write(dac.index, points, pps)
                        wrote = True
                    except Exception as exc:
                        if now - self._last_error_log > 1.0:
                            log.warning("Error enviando al DAC %s: %s", dac.index, exc)
                            self._last_error_log = now
        if not wrote:
            remaining = 1.0 / IDLE_FPS - (self._clock() - now)
            if remaining > 0:
                self._sleep(remaining)

    # ----- persistence (own thread: file I/O must never delay a frame) ---------------------------------------
    def flush(self):
        """Save settings and cues if they changed. A failed save stays dirty and is retried."""
        if not self.store:
            return
        with self._persist_lock:
            with self._lock:
                if not self._dirty:
                    return
                data = {"settings": dict(self.settings), "cues": copy.deepcopy(self.cues)}
                self._dirty = False
            try:
                self.store.save(data)
            except (OSError, ValueError):
                log.exception("No se pudo guardar el estado")
                with self._lock:
                    self._dirty = True

    def _persist_loop(self):
        while not self._stop_persist.wait(PERSIST_INTERVAL):
            self.flush()

    def start(self):
        self.open()
        self._running = True
        self._thread = threading.Thread(target=self._run, name="helios-render", daemon=True)
        self._thread.start()
        threading.Thread(target=self._persist_loop, name="helios-persist", daemon=True).start()

    def _run(self):
        while self._running:
            try:
                self.step()
            except Exception:
                log.exception("Error en el bucle de render")
                self._sleep(0.1)

    def shutdown(self):
        """Stop output, close the shutter and the DACs, persist."""
        self._running = False
        self._stop_persist.set()
        self.disarm()
        if self._thread:
            self._thread.join(timeout=2.0)
        with self._out_lock:
            self._safe(self.output.close)
        self.flush()
