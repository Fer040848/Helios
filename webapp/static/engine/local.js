// In-browser backend for the published site (dac.ferchx.com): the same protocol and safety rules as the Python
// server (helios_web/engine.py + server.py), with the DAC driven over WebUSB. Without a DAC it runs the simulator.
//
// Safety: starts disarmed (armed is never stored); nothing is written while disarmed (the loop checks `armed`
// synchronously right before queueing each frame, and every USB transfer of a DAC runs through one serial queue,
// so a blackout's Stop + shutter-close is queued after any frame already in flight and before any later one);
// brightness / scan area / beam safety / trailing blank come from rasterize.js; frames use SINGLE_MODE; a DAC error,
// an unplugged DAC or the app going to the background blacks out.
import * as model from "./model.js";
import { Clocks, compose } from "./effects.js";
import { buildFrame } from "./rasterize.js";
import { HELIOS_FILTER, HeliosUsbDac, USB_MAX_POINTS } from "./helios-usb.js";

const STORAGE_KEY = "helios-web/v1";
const IDLE_FPS = 30,
  MAX_DT = 0.1,
  FRAME_MS = 50,
  STATE_MS = 100,
  MAX_PREVIEW_VERTICES = 1500,
  PERSIST_MS = 500;
const TAP_RESET = 2,
  TAP_WINDOW = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));

class SimDac {
  constructor() {
    Object.assign(this, { index: 0, name: "Simulador", kind: "sim", next: 0 });
  }
  async write(points, pps) {
    const now = performance.now(),
      dur = (points.length / pps) * 1000;
    this.next = Math.max(this.next, now) + dur;
    const delay = this.next - now - dur; // stay at most one frame ahead, like the DAC's double buffer
    if (delay > 0) await sleep(delay);
    return true;
  }
  async stop() {
    this.next = 0;
  }
  async shutter() {}
  async close() {}
}

/** Encode preview strokes as flat [x, y, r, g, b, ...] lists (same as server.frame_message). */
export function frameMessage(strokes, fps, points) {
  const total = strokes.reduce(
    (s, st) => s + st.points.length + (st.closed ? 1 : 0),
    0,
  );
  const step = Math.max(1, Math.ceil(total / MAX_PREVIEW_VERTICES));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = strokes.map((st) => {
    const pts =
      step > 1 && st.points.length > 2
        ? st.points.filter((_, i) => i % step === 0)
        : [...st.points];
    if (st.closed && pts.length > 1) pts.push(pts[0]);
    return pts.flatMap(([x, y, r, g, b]) => [
      r3(x),
      r3(y),
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255),
    ]);
  });
  return {
    type: "frame",
    strokes: out,
    fps: Math.round(fps * 10) / 10,
    points,
  };
}

export class LocalBackend {
  constructor({
    onMessage,
    onStatus,
    usb = globalThis.navigator?.usb,
    storage = globalThis.localStorage,
    doc = globalThis.document,
  }) {
    Object.assign(this, { onMessage, onStatus, usb, storage, doc });
    const saved = this._load();
    this.scene = model.defaultScene();
    this.settings = model.mergeSettings(
      model.SETTINGS_DEFAULTS,
      saved.settings,
    );
    this.cues = saved.cues ? model.cleanCues(saved.cues) : model.defaultCues();
    this.armed = false;
    this.activeCue = null;
    this.bpm = 120;
    this.sim = new SimDac();
    this.usbDacs = [];
    this.clocks = new Clocks();
    this.preview = [];
    this.fps = 0;
    this.points = 0;
    this.version = 0;
    this.taps = [];
    this.running = false;
    this.wakeLock = null;
  }

  get dacs() {
    return this.usbDacs.length ? this.usbDacs : [this.sim];
  }

  // ----- lifecycle -----------------------------------------------------------------------------------------
  start() {
    this.running = true;
    this.onStatus?.("open");
    this._emitState();
    this._loop();
    this._ticker = setInterval(() => this._tick(), FRAME_MS);
    if (this.usb) {
      this.usb.addEventListener?.("disconnect", (ev) =>
        this._onUnplug(ev.device),
      );
      this.usb.addEventListener?.("connect", (ev) =>
        this._addDevice(ev.device),
      );
      this.usb
        .getDevices?.()
        .then((devices) => devices.forEach((d) => this._addDevice(d)))
        .catch(() => {});
    }
    this.doc?.addEventListener?.("visibilitychange", () => {
      if (this.doc.hidden && this.armed) {
        this.disarm();
        this._error("La salida se apagó porque la app pasó a segundo plano.");
      }
    });
  }

  stop() {
    this.running = false;
    clearInterval(this._ticker);
    return this.disarm();
  }

  // ----- messages (same protocol as the Python server) --------------------------------------------------------
  send(msg) {
    const error = this.handle(msg);
    if (error) this._error(error);
    return true;
  }

  handle(data) {
    if (!data || typeof data !== "object" || Array.isArray(data))
      return "Mensaje inválido";
    try {
      switch (data.type) {
        case "scene":
          this.scene = model.mergeScene(this.scene, data.scene);
          this.activeCue = null;
          return this._changed();
        case "settings":
          this.settings = model.mergeSettings(this.settings, data.settings);
          return this._changed(true);
        case "arm":
          if (typeof data.armed !== "boolean") return "Falta 'armed'";
          data.armed ? this.arm() : this.disarm();
          return null;
        case "blackout":
          this.disarm();
          return null;
        case "cue": {
          const i = this._slot(data.index);
          if (!this.cues[i]) return null;
          this.scene = model.mergeScene(
            model.SCENE_DEFAULTS,
            this.cues[i].scene,
          );
          this.activeCue = i;
          return this._changed();
        }
        case "saveCue": {
          const i = this._slot(data.index);
          const name = [
            ...(typeof data.name === "string" ? data.name.trim() : ""),
          ]
            .slice(0, model.MAX_CUE_NAME)
            .join("");
          this.cues[i] = {
            name: name || `Cue ${i + 1}`,
            scene: clone(this.scene),
          };
          return this._changed(true);
        }
        case "clearCue": {
          const i = this._slot(data.index);
          this.cues[i] = null;
          if (this.activeCue === i) this.activeCue = null;
          return this._changed(true);
        }
        case "tap":
          this.tap();
          return null;
        case "bpm": {
          const v = model.clampNumber(data.bpm, ...model.BPM_RANGE);
          if (v === null) return "BPM inválido";
          this.bpm = v;
          return this._changed();
        }
        case "rescan":
          return this.connectUsb();
        default:
          return `Tipo de mensaje desconocido: ${JSON.stringify(data.type)}`;
      }
    } catch (err) {
      return err.message;
    }
  }

  _slot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= model.CUE_SLOTS)
      throw new Error("Cue inválido");
    return index;
  }

  tap(now = performance.now() / 1000) {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > TAP_RESET)
      this.taps = [];
    this.taps = [...this.taps, now].slice(-(TAP_WINDOW + 1));
    if (this.taps.length >= 2) {
      const iv = this.taps.slice(1).map((t, i) => t - this.taps[i]);
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      if (mean > 0) {
        this.bpm = Math.min(
          model.BPM_RANGE[1],
          Math.max(model.BPM_RANGE[0], 60 / mean),
        );
        this.clocks.beats = Math.floor(this.clocks.beats) + 0.999; // next frame starts a beat
      }
    }
    this._changed();
  }

  // ----- output control ----------------------------------------------------------------------------------
  arm() {
    if (this.armed) return Promise.resolve();
    this.armed = true;
    this._changed();
    this.doc &&
      navigator.wakeLock
        ?.request("screen")
        .then((l) => (this.wakeLock = l))
        .catch(() => {});
    return Promise.all(this.dacs.map((d) => d.shutter(true).catch(() => {})));
  }

  disarm() {
    this.armed = false;
    this._changed();
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    return Promise.all(
      this.dacs.map((d) =>
        Promise.all([
          d.stop().catch(() => {}),
          d.shutter(false).catch(() => {}),
        ]),
      ),
    );
  }

  /** Ask the browser for a Helios DAC (needs the user's tap, so it is called synchronously from send()). */
  connectUsb() {
    if (this.armed) return "Apaga la salida antes de buscar DACs";
    if (!this.usb?.requestDevice) {
      return "Este navegador no puede usar USB. Abre la página en Chrome o Edge (Android o computadora).";
    }
    this.usb
      .requestDevice({ filters: [HELIOS_FILTER] })
      .then((device) => this._addDevice(device))
      .catch((err) => {
        if (err?.name !== "NotFoundError")
          this._error(`No se pudo conectar el DAC: ${err?.message || err}`);
      });
    return null;
  }

  async _addDevice(device) {
    if (
      device.vendorId !== HELIOS_FILTER.vendorId ||
      device.productId !== HELIOS_FILTER.productId
    )
      return;
    if (this.usbDacs.some((d) => d.device === device)) return;
    const dac = new HeliosUsbDac(device, this.usbDacs.length);
    try {
      await dac.open();
    } catch (err) {
      dac.close();
      this._error(`No se pudo abrir el DAC: ${err.message}`);
      return;
    }
    if (this.armed) await this.disarm(); // the output set changes: never carry an armed state across it
    this.usbDacs.push(dac);
    this._changed();
  }

  _onUnplug(device) {
    const dac = this.usbDacs.find((d) => d.device === device);
    if (dac) this._dropDac(dac, "El DAC se desconectó.");
  }

  _dropDac(dac, message) {
    const wasArmed = this.armed;
    this.armed = false;
    this.usbDacs = this.usbDacs.filter((d) => d !== dac);
    this.usbDacs.forEach((d, i) => (d.index = i));
    dac.close();
    if (wasArmed) this.disarm();
    this._changed();
    this._error(message + (wasArmed ? " La salida se apagó." : ""));
  }

  // ----- render loop ---------------------------------------------------------------------------------------
  render(dt) {
    this.clocks.advance(
      Math.min(Math.max(dt, 0), MAX_DT),
      this.scene,
      this.bpm,
    );
    const { preview, points } = buildFrame(
      compose(this.scene, this.clocks),
      this.settings,
      USB_MAX_POINTS,
    );
    this.preview = preview;
    this.points = points.length;
    return points;
  }

  async _loop() {
    let last = performance.now(),
      avg = 0;
    while (this.running) {
      const t0 = performance.now(),
        dt = (t0 - last) / 1000;
      last = t0;
      if (dt > 0) {
        avg = avg ? 0.9 * avg + 0.1 * dt : dt;
        this.fps = 1 / avg;
      }
      const points = this.render(dt);
      let wrote = false;
      for (const dac of this.dacs) {
        if (!this.armed) break; // checked synchronously right before queueing the frame
        try {
          if (await dac.write(points, this.settings.pps)) wrote = true;
        } catch (err) {
          if (dac !== this.sim)
            this._dropDac(
              dac,
              `Se perdió la conexión con el DAC (${err.message}).`,
            );
        }
      }
      // always yield to the event loop: the UI, timers and a blackout tap must never wait on the output loop
      if (!wrote) await sleep(Math.max(0, 1000 / IDLE_FPS - (performance.now() - t0)));
      else await sleep(0);
    }
  }

  // ----- state out -----------------------------------------------------------------------------------------
  getState() {
    return {
      armed: this.armed,
      simulated: !this.usbDacs.length,
      dacs: this.dacs.map((d) => ({
        index: d.index,
        name: d.name,
        kind: d.kind,
      })),
      scene: clone(this.scene),
      settings: { ...this.settings },
      cues: clone(this.cues),
      activeCue: this.activeCue,
      bpm: Math.round(this.bpm * 10) / 10,
      transport: "webusb",
      usbSupported: !!this.usb?.requestDevice,
      ...model.catalog(),
    };
  }

  _changed(persist = false) {
    this.version++;
    if (persist) {
      clearTimeout(this._persistTimer);
      this._persistTimer = setTimeout(() => this._save(), PERSIST_MS);
    }
    return null;
  }

  _tick() {
    const now = performance.now();
    if (
      this.version !== this._sentVersion &&
      now - (this._lastState || 0) >= STATE_MS
    )
      this._emitState();
    this.onMessage(frameMessage(this.preview, this.fps, this.points));
  }

  _emitState() {
    this._sentVersion = this.version;
    this._lastState = performance.now();
    this.onMessage({ type: "state", state: this.getState() });
  }

  _error(message) {
    this.onMessage({ type: "error", message });
  }

  _load() {
    try {
      const data = JSON.parse(this.storage?.getItem(STORAGE_KEY) || "{}");
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  _save() {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ settings: this.settings, cues: this.cues }),
      );
    } catch {
      /* storage full or disabled: keep running */
    }
  }
}
