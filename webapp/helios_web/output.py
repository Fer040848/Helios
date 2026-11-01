"""DAC output backends.

``HeliosLibOutput`` drives real DACs through the Helios SDK shared library (ctypes); ``SimulatedOutput`` stands in
when there is no hardware; ``AutoOutput`` picks between them and re-scans on demand.
All ``write`` calls take points as ``(x, y, r, g, b)`` floats (x/y in [-1, 1], colours in [0, 1]).
"""

import ctypes
import logging
import os
import sys
import time
from dataclasses import dataclass

log = logging.getLogger(__name__)

FLAGS_SINGLE_MODE = (
    2  # HELIOS_FLAGS_SINGLE_MODE: play each frame once, so a stalled server goes dark
)
USB_MAX_POINTS = 0xFFF
STATUS_TIMEOUT = 0.1  # seconds to wait for a DAC buffer to free up
_WEBAPP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO = os.path.dirname(_WEBAPP)


@dataclass
class DacInfo:
    index: int
    name: str
    kind: str  # "usb" | "idn" | "sim"

    def as_dict(self):
        return {"index": self.index, "name": self.name, "kind": self.kind}


class HeliosPoint(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_uint16),
        ("y", ctypes.c_uint16),
        ("r", ctypes.c_uint8),
        ("g", ctypes.c_uint8),
        ("b", ctypes.c_uint8),
        ("i", ctypes.c_uint8),
    ]


class HeliosPointHighRes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_uint16),
        ("y", ctypes.c_uint16),
        ("r", ctypes.c_uint16),
        ("g", ctypes.c_uint16),
        ("b", ctypes.c_uint16),
    ]


def _unit(v):
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def to_highres(points):
    buf = (HeliosPointHighRes * len(points))()
    for i, (x, y, r, g, b) in enumerate(points):
        buf[i] = HeliosPointHighRes(
            round(_unit((x + 1) / 2) * 0xFFFF),
            round(_unit((y + 1) / 2) * 0xFFFF),
            round(_unit(r) * 0xFFFF),
            round(_unit(g) * 0xFFFF),
            round(_unit(b) * 0xFFFF),
        )
    return buf


def to_lowres(points):
    buf = (HeliosPoint * len(points))()
    for i, (x, y, r, g, b) in enumerate(points):
        r8, g8, b8 = round(_unit(r) * 255), round(_unit(g) * 255), round(_unit(b) * 255)
        buf[i] = HeliosPoint(
            round(_unit((x + 1) / 2) * 0xFFF),
            round(_unit((y + 1) / 2) * 0xFFF),
            r8,
            g8,
            b8,
            255 if (r8 or g8 or b8) else 0,
        )
    return buf


def library_candidates(explicit=None):
    """Library paths in search order: --lib, $HELIOS_LIB, webapp/lib, then the SDK's prebuilt copies."""
    if sys.platform.startswith("win"):
        names = [
            os.path.join(_WEBAPP, "lib", "HeliosLaserDAC.dll"),
            os.path.join(_REPO, "sdk", "cpp", "shared_library", "HeliosLaserDAC.dll"),
        ]
    elif sys.platform == "darwin":
        names = [
            os.path.join(_WEBAPP, "lib", "libHeliosDacAPI.dylib"),
            os.path.join(
                _REPO, "sdk", "cpp", "shared_library", "libHeliosLaserDAC.dylib"
            ),
        ]
    else:
        names = [
            os.path.join(_WEBAPP, "lib", "libHeliosDacAPI.so"),
            os.path.join(_REPO, "sdk", "examples", "python", "libHeliosDacAPI.so"),
        ]
    first = [p for p in (explicit, os.environ.get("HELIOS_LIB")) if p]
    return first + names


def load_library(path):
    """Load the SDK library (CDLL). On Windows its own folder is added so libusb-1.0.dll beside it is found."""
    path = os.path.abspath(path)
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(os.path.dirname(path))
    return ctypes.CDLL(path)


class SimulatedOutput:
    """No hardware: accepts frames and paces the caller by each frame's duration."""

    simulated = True
    max_points = USB_MAX_POINTS

    def __init__(self, clock=time.monotonic, sleep=time.sleep):
        self._clock, self._sleep, self._next = clock, sleep, 0.0
        self.frames_written = 0

    def open(self):
        return [DacInfo(0, "Simulador", "sim")]

    def write(self, index, points, pps):
        now = self._clock()
        self._next = max(self._next, now) + len(points) / pps
        self.frames_written += 1
        # stay at most one frame ahead, like the DAC's double buffer
        delay = self._next - now - len(points) / pps
        if delay > 0:
            self._sleep(delay)

    def stop(self, index):
        self._next = 0.0

    def shutter(self, index, is_open):
        pass

    def close(self):
        pass


class HeliosLibOutput:
    """Real DACs through the Helios SDK library. ``lib`` is a loaded CDLL (or a test double)."""

    simulated = False
    max_points = USB_MAX_POINTS

    def __init__(self, lib, sleep=time.sleep, clock=time.monotonic):
        self._lib, self._sleep, self._clock = lib, sleep, clock
        self.highres = hasattr(lib, "WriteFrameHighResolution")
        self._count = 0
        u, i, p = ctypes.c_uint, ctypes.c_int, ctypes.c_void_p
        signatures = {
            "OpenDevices": ([], i),
            "CloseDevices": ([], i),
            "GetStatus": ([u], i),
            "Stop": ([u], i),
            "SetShutter": ([u, ctypes.c_bool], i),
            "GetName": ([u, ctypes.c_char_p], i),
            "GetIsUsb": ([u], i),
            "WriteFrame": ([u, i, ctypes.c_uint8, p, i], i),
            "WriteFrameHighResolution": ([u, i, ctypes.c_uint8, p, i], i),
        }
        for name, (args, res) in signatures.items():
            if hasattr(lib, name):
                fn = getattr(lib, name)
                fn.argtypes, fn.restype = args, res

    def open(self):
        self._count = max(0, self._lib.OpenDevices())
        dacs = []
        for index in range(self._count):
            buf = ctypes.create_string_buffer(32)
            name = f"Helios {index + 1}"
            if self._lib.GetName(index, buf) >= 0 and buf.value:
                name = buf.value.decode("utf-8", "replace")
            kind = "usb"
            if hasattr(self._lib, "GetIsUsb") and self._lib.GetIsUsb(index) == 0:
                kind = "idn"
            dacs.append(DacInfo(index, name, kind))
        return dacs

    def write(self, index, points, pps):
        deadline = self._clock() + STATUS_TIMEOUT
        while True:
            status = self._lib.GetStatus(index)
            if status == 1:
                break
            if status < 0:
                raise IOError(f"DAC {index}: GetStatus error {status}")
            if self._clock() >= deadline:
                return  # buffer still full: drop this frame rather than block the loop
            self._sleep(0.0005)
        if self.highres:
            buf = to_highres(points)
            result = self._lib.WriteFrameHighResolution(
                index,
                pps,
                FLAGS_SINGLE_MODE,
                ctypes.cast(buf, ctypes.c_void_p),
                len(points),
            )
        else:
            buf = to_lowres(points)
            result = self._lib.WriteFrame(
                index,
                pps,
                FLAGS_SINGLE_MODE,
                ctypes.cast(buf, ctypes.c_void_p),
                len(points),
            )
        if result < 0:
            raise IOError(f"DAC {index}: write error {result}")

    def stop(self, index):
        self._lib.Stop(index)

    def shutter(self, index, is_open):
        self._lib.SetShutter(index, bool(is_open))

    def close(self):
        self._lib.CloseDevices()
        self._count = 0


class AutoOutput:
    """Uses the hardware output when it finds DACs, otherwise the simulator. ``open`` re-scans."""

    def __init__(self, hardware=None, simulator=None):
        self.hardware = hardware
        self.simulator = simulator or SimulatedOutput()
        self.active = self.simulator

    @property
    def simulated(self):
        return self.active.simulated

    @property
    def max_points(self):
        return self.active.max_points

    def open(self):
        if self.hardware is not None:
            try:
                self.hardware.close()
                dacs = self.hardware.open()
            except Exception:  # a broken library must not take the app down
                log.exception("No se pudo abrir la librería del DAC")
                dacs = []
            if dacs:
                self.active = self.hardware
                log.info("DACs encontrados: %s", ", ".join(d.name for d in dacs))
                return dacs
            log.warning("No se encontró ningún DAC: usando el simulador")
        self.active = self.simulator
        return self.simulator.open()

    def write(self, index, points, pps):
        self.active.write(index, points, pps)

    def stop(self, index):
        self.active.stop(index)

    def shutter(self, index, is_open):
        self.active.shutter(index, is_open)

    def close(self):
        self.active.close()


def create_output(simulate=False, lib_path=None):
    """Build the output for the CLI: the simulator, or hardware with simulator fallback."""
    if simulate:
        return AutoOutput()
    for path in library_candidates(lib_path):
        if os.path.isfile(path):
            try:
                lib = load_library(path)
            except OSError as exc:
                log.warning("No se pudo cargar %s: %s", path, exc)
                continue
            log.info("Librería del DAC: %s", path)
            return AutoOutput(HeliosLibOutput(lib))
    log.warning("No se encontró la librería del DAC: usando el simulador")
    return AutoOutput()
