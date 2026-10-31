# Helios Web Control — design & contract

A laser show controller (cue grid + live controls, in the spirit of desktop/mobile laser
show apps) that runs on the computer the Helios DAC is plugged into, and is operated from a
phone browser on the same Wi‑Fi. UI language: Spanish. Code, identifiers and comments: English.

```
 phone / tablet / PC browser  ──HTTP + WebSocket (LAN)──▶  python -m helios_web  ──ctypes──▶  libHeliosDacAPI  ──USB/IDN──▶  DAC ─▶ projector
                                                                 └── simulator (no hardware) ──▶ preview only
```

## Layout

```
webapp/
  DESIGN.md                this file
  README.md                user guide (Spanish)
  requirements.txt         aiohttp>=3.9  (the only runtime dependency)
  scripts/build_helios_lib.sh   compiles sdk/cpp (current, HighRes+IDN) into webapp/lib/
  helios_web/              Python package (backend)
    __main__.py            CLI entry: python -m helios_web
    geometry.py            stroke types, transforms, mirroring
    font.py                single-stroke vector font
    patterns.py            pattern registry
    effects.py             motion effects + colour modes + beat clock
    rasterize.py           strokes -> galvo-friendly point stream, safety
    output.py              DAC backends: HeliosLibOutput (ctypes), SimulatedOutput
    engine.py              state, cues, render thread
    store.py               JSON persistence of settings + cues
    server.py              aiohttp app: static, REST, WebSocket
  static/                  frontend (vanilla HTML/CSS/JS, no build step, no CDN)
    index.html  app.css  app.js  manifest.webmanifest  icon.svg
  tests/                   python -m unittest discover -s webapp/tests -t webapp
    e2e/                   Playwright (Node, CommonJS) UI tests
  data/                    runtime persistence (gitignored)
  lib/                     locally built DAC library (gitignored)
```

## Conventions

- Coordinates are floats, `x, y ∈ [-1, 1]`, `+y` is up, `(0,0)` is centre. Colours are floats `r, g, b ∈ [0, 1]`
  inside the backend and ints `0..255` on the wire.
- A **stroke** is a polyline: a list of `(x, y)` vertices plus a `closed` flag. A **coloured stroke** carries one
  colour per vertex (the colour of the segment that starts at that vertex).
- The server is the single source of truth. Clients send intents; the server validates, clamps, applies and
  broadcasts the resulting full state.

## Safety rules (non-negotiable)

1. The server always starts **disarmed**. `armed` is never persisted.
2. While disarmed, nothing is written to any DAC. Disarm / blackout calls `Stop()` and `SetShutter(0)` on every DAC.
3. `settings.brightness` (master, default 0.3) multiplies every colour sent to the DAC.
4. `settings.scanSize` (0.1–1, default 0.8) scales every output coordinate; results are clamped to [-1, 1].
5. Beam safety (`settings.beamSafety`, default true): if the bounding box of the lit points of a frame is smaller
   than 0.05 in both width and height (normalised units, full range = 2), the whole frame is blanked.
6. Frames are written with `HELIOS_FLAGS_SINGLE_MODE` (value 2) so the DAC stops by itself if the server stalls.
7. On shutdown (SIGINT/SIGTERM) the server stops, closes the shutter and closes all DACs.

## Scene (what is drawn)

All fields optional on input; the server merges partial updates, clamps numbers to range, ignores unknown keys
and invalid enum values.

| field          | type / range                                                                                     | default     | meaning                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pattern`      | pattern id (see registry)                                                                        | `"circle"`  | base shape                                                                                                             |
| `text`         | string, ≤ 64 chars                                                                               | `"HOLA"`    | used by `text` pattern                                                                                                 |
| `textMode`     | `"static"` \| `"scroll"`                                                                         | `"static"`  |                                                                                                                        |
| `drawing`      | list of strokes, each a list of `[x, y]`                                                         | `[]`        | used by `drawing` pattern; ≤ 2000 points total (server truncates)                                                      |
| `size`         | 0–1                                                                                              | 0.6         | overall scale (1 = shape spans full range)                                                                             |
| `x`, `y`       | -1–1                                                                                             | 0           | position                                                                                                               |
| `rotation`     | -180–180 (degrees)                                                                               | 0           | static rotation                                                                                                        |
| `spin`         | -360–360 (degrees / second)                                                                      | 0           | continuous rotation                                                                                                    |
| `speed`        | 0–2                                                                                              | 1           | animation speed of animated patterns and text scroll                                                                   |
| `color`        | `"#rrggbb"`                                                                                      | `"#00ff00"` | base colour                                                                                                            |
| `colorMode`    | `solid` \| `rainbow` \| `cycle` \| `beat`                                                        | `"solid"`   | rainbow = hue along the path (moving); cycle = whole shape hue over time; beat = jump to next palette colour each beat |
| `colorSpeed`   | 0–2                                                                                              | 0.5         |                                                                                                                        |
| `effect`       | `none` \| `pulse` \| `wave` \| `orbit` \| `bounce` \| `zoom` \| `strobe` \| `wobble` \| `drawOn` | `"none"`    | motion effect                                                                                                          |
| `effectAmount` | 0–1                                                                                              | 0.5         |                                                                                                                        |
| `effectSpeed`  | 0–2                                                                                              | 0.5         | ignored when `beatSync` (period follows BPM)                                                                           |
| `beatSync`     | bool                                                                                             | false       |                                                                                                                        |
| `mirror`       | `none` \| `h` \| `v` \| `quad`                                                                   | `"none"`    | duplicate mirrored copies                                                                                              |

Pattern registry (id → Spanish name): `circle` Círculo, `square` Cuadrado, `triangle` Triángulo, `star` Estrella,
`heart` Corazón, `line` Línea, `spiral` Espiral, `wave` Onda, `lissajous` Lissajous, `tunnel` Túnel, `fan` Abanico,
`grid` Rejilla, `flower` Flor, `text` Texto, `drawing` Dibujo. Effects / colour modes have Spanish names too
(e.g. `pulse` Pulso, `wave` Ondulación, `orbit` Órbita, `bounce` Rebote, `zoom` Zoom, `strobe` Estrobo,
`wobble` Vaivén, `drawOn` Trazado; `solid` Sólido, `rainbow` Arcoíris, `cycle` Ciclo, `beat` Al ritmo).

## Settings (projector / output)

| field                          | range      | default |                       |
| ------------------------------ | ---------- | ------- | --------------------- |
| `pps`                          | 1000–65535 | 30000   | points per second     |
| `brightness`                   | 0–1        | 0.3     | master intensity      |
| `scanSize`                     | 0.1–1      | 0.8     | output scan area      |
| `invertX`, `invertY`, `swapXY` | bool       | false   | projector orientation |
| `beamSafety`                   | bool       | true    | see safety rule 5     |

Settings and cues persist to `data/state.json`. Scene does not persist (cues do).

## Cues

16 slots; `null` = empty. A cue is `{"name": str (≤ 24 chars), "scene": Scene}`. The first ~10 slots ship with
sensible defaults (e.g. green circle, rainbow tunnel, spinning star, wave, text "HOLA", fan, lissajous, red heart,
grid, spiral). Triggering a cue replaces the live scene with the cue's scene (merged over scene defaults) and sets
`activeCue`. Any later `scene` message clears `activeCue` to `null`.

## HTTP

- `GET /` → `static/index.html`; `GET /static/<file>` → static files.
- `GET /api/state` → the `state` object (same shape as the WebSocket `state.state`).
- `GET /ws` → WebSocket.
- Default bind `0.0.0.0:8080`; at start-up the server prints the LAN URL(s) to open on the phone.

## WebSocket protocol (JSON text messages)

Server → client:

- `{"type": "state", "state": State}` — sent on connect and after every change (coalesced to ≤ 10 per second).
- `{"type": "frame", "strokes": [[x, y, r, g, b, x, y, r, g, b, ...], ...], "fps": float, "points": int}` — ~20 per
  second to every client, whether armed or not. Strokes are the coloured strokes after effects, mirroring and the
  output transform (scanSize, invert, swap), colours before brightness, x/y rounded to 3 decimals, r/g/b ints 0–255,
  ≤ 1500 vertices in total (downsampled if needed). Empty `strokes` when beam safety blanks the frame.
  `fps` = frames per second actually rendered; `points` = points in the last frame written / rasterised.
- `{"type": "error", "message": str}` — invalid message; the connection stays open.

Client → server:

| message                                                | effect                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `{"type": "scene", "scene": {partial Scene}}`          | merge into live scene; `activeCue = null`                                                        |
| `{"type": "settings", "settings": {partial Settings}}` | merge, persist                                                                                   |
| `{"type": "arm", "armed": bool}`                       | arm / disarm output                                                                              |
| `{"type": "blackout"}`                                 | disarm immediately                                                                               |
| `{"type": "cue", "index": int}`                        | trigger cue (ignored if slot empty)                                                              |
| `{"type": "saveCue", "index": int, "name": str}`       | store current scene in slot, persist                                                             |
| `{"type": "clearCue", "index": int}`                   | empty slot, persist                                                                              |
| `{"type": "tap"}`                                      | tap tempo: BPM = 60 / mean of the last ≤ 4 intervals; taps more than 2 s apart restart the count |
| `{"type": "bpm", "bpm": number}`                       | set BPM (40–240)                                                                                 |
| `{"type": "rescan"}`                                   | re-open DACs (only while disarmed; else `error`)                                                 |

State:

```json
{
  "armed": false,
  "simulated": true,
  "dacs": [{ "index": 0, "name": "Helios 1", "kind": "usb" }],
  "scene": { "...": "Scene" },
  "settings": { "...": "Settings" },
  "cues": [{ "name": "Círculo", "scene": {} }, null],
  "activeCue": null,
  "bpm": 120.0,
  "patterns": [{ "id": "circle", "name": "Círculo" }],
  "effects": [{ "id": "none", "name": "Ninguno" }],
  "colorModes": [{ "id": "solid", "name": "Sólido" }]
}
```

`dacs[].kind` is `usb`, `idn` or `sim`. With no hardware the server runs the simulator (`simulated: true`, one
`sim` DAC) so the UI and preview work without a laser.

## Output backends

- `HeliosLibOutput(lib_path)` — ctypes `CDLL`. Uses `WriteFrameHighResolution` (16-bit XY/RGB) when the library
  exports it, otherwise `WriteFrame` (12-bit XY, 8-bit RGBI; I = 255 when any colour is lit). Library search order:
  `--lib`, `$HELIOS_LIB`, `webapp/lib/`, `sdk/cpp/shared_library/` (Windows `.dll`, macOS `.dylib`),
  `sdk/examples/python/` (Linux `.so`). Per frame and DAC: poll `GetStatus` until 1 (bounded), then write.
  Max points per frame 4095 (USB).
- `SimulatedOutput` — accepts frames and paces the loop by the frame duration (`points / pps`).
- If the library is missing or finds 0 DACs, the server falls back to the simulator and says so in the log;
  `rescan` retries the hardware.

## Rasteriser (strokes → points)

Blanked moves between strokes (interpolated, then a few blanked dwell points at the target), lit points spaced
evenly along each stroke, extra dwell points on sharp corners (> ~45°) and at stroke ends, closed strokes return to
their first vertex. Each frame has at least `max(200, pps × 0.012)` points (pad by repeating) and at most 4095
(resample coarser to fit). Then: brightness, scanSize, invert/swap, clamp, beam safety.
