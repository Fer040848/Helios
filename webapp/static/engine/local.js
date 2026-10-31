// In-browser backend for the published site (dac.ferchx.com): the same protocol and safety rules as the Python
// server (helios_web/engine.py + server.py), with the DAC driven over WebUSB. Without a DAC it runs the simulator.
//
// Safety:
// - starts disarmed (armed is never stored) and every DAC is put in Stop + shutter-closed when opened;
// - nothing is written while disarmed: the loop checks `armed` right before queueing a frame, and the DAC checks it
//   again synchronously right before the frame goes on the wire, so no frame follows a blackout;
// - every USB transfer of a DAC runs through one serial queue with deadlines, so a blackout's Stop + shutter-close is
//   sent after at most one in-flight (time-bounded) transfer, and a wedged DAC cannot freeze the loop;
// - brightness / scan area / beam safety / trailing blank come from rasterize.js; frames use SINGLE_MODE;
// - a DAC error, an unplugged or newly plugged DAC, or the page going to the background blacks out, and a DAC
//   dropped for an error still gets Stop + shutter-close before it is closed.
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
const RECONNECT_HINT =
  "Toca «Conectar DAC por USB» en Ajustes para volver a conectarlo.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** localStorage, or null when the browser blocks site storage (reading the property itself can throw). */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

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
    storage = defaultStorage(),
    doc = globalThis.document,
    wakeLock = globalThis.navigator?.wakeLock,
  }) {
    Object.assign(this, {
      onMessage,
      onStatus,
      usb,
      storage,
      doc,
      wakeLockApi: wakeLock,
    });
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
    this.pendingNotice = null;
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
    this.doc?.addEventListener?.("visibilitychange", () =>
      this._onVisibility(),
    );
  }

  stop() {
    this.running = false;
    clearInterval(this._ticker);
    return this.disarm();
  }

  _onVisibility() {
    if (this.doc.hidden) {
      if (this.armed) {
        this.disarm();
        // a toast raised now would expire unseen: show it when the page is visible again
        this.pendingNotice =
          "La salida se apagó porque la app pasó a segundo plano.";
      }
    } else if (this.pendingNotice) {
      this._error(this.pendingNotice);
      this.pendingNotice = null;
    }
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
          const name = model.cleanName(
            typeof data.name === "string" ? data.name.trim() : "",
          );
          this.cues = this.cues.map((c, k) =>
            k === i
              ? { name: name || `Cue ${i + 1}`, scene: clone(this.scene) }
              : c,
          );
          return this._changed(true);
        }
        case "clearCue": {
          const i = this._slot(data.index);
          this.cues = this.cues.map((c, k) => (k === i ? null : c));
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
    this.wakeLockApi
      ?.request?.("screen")
      .then((lock) => {
        // a blackout may have come first, or a second arm: never keep a lock the output no longer needs
        if (!this.armed || this.wakeLock) lock.release().catch(() => {});
        else this.wakeLock = lock;
      })
      .catch(() => {});
    return Promise.all(this.dacs.map((d) => d.shutter(true).catch(() => {})));
  }

  disarm() {
    this.armed = false;
    this._changed();
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    return Promise.all(this.dacs.map((d) => this._blackoutDac(d)));
  }

  _blackoutDac(dac) {
    return Promise.all([
      dac.stop().catch(() => {}),
      dac.shutter(false).catch(() => {}),
    ]);
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
      await dac.open(); // also leaves the DAC stopped with its shutter closed
    } catch (err) {
      dac.close();
      this._error(`No se pudo abrir el DAC: ${err.message}`);
      return;
    }
    if (this.usbDacs.some((d) => d.device === device)) return; // added meanwhile (connect event + getDevices)
    // The output set changes: never carry an armed state across it. Synchronous from here on, so no arm() can
    // slip in between the check and the change.
    const wasArmed = this.armed;
    this.armed = false;
    this.usbDacs.push(dac);
    if (wasArmed) {
      this.disarm();
      this._error("Se conectó un DAC: la salida se apagó por seguridad.");
    }
    this._changed();
  }

  _onUnplug(device) {
    const dac = this.usbDacs.find((d) => d.device === device);
    if (dac) this._dropDac(dac, "El DAC se desconectó.", true);
  }

  _dropDac(dac, message, unplugged = false) {
    if (!this.usbDacs.includes(dac)) return; // already dropped (an unplug also fails the in-flight write)
    const wasArmed = this.armed;
    this.armed = false;
    this.usbDacs = this.usbDacs.filter((d) => d !== dac);
    this.usbDacs.forEach((d, i) => (d.index = i));
    // best effort: a DAC dropped for an error may still be listening; it must not keep its shutter open
    if (!unplugged) this._blackoutDac(dac);
    dac.close();
    if (wasArmed) this.disarm();
    this._changed();
    this._error(
      `${message}${wasArmed ? " La salida se apagó." : ""} ${RECONNECT_HINT}`,
    );
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
    const armed = () => this.armed;
    while (this.running) {
      const t0 = performance.now(),
        dt = (t0 - last) / 1000;
      last = t0;
      if (dt > 0) {
        avg = avg ? 0.9 * avg + 0.1 * dt : dt;
        this.fps = 1 / avg;
      }
      let wrote = false;
      try {
        const points = this.render(dt);
        for (const dac of this.dacs) {
          if (!this.armed) break; // checked right before queueing the frame
          try {
            if (await dac.write(points, this.settings.pps, armed)) wrote = true;
          } catch (err) {
            if (dac !== this.sim)
              this._dropDac(
                dac,
                `Se perdió la conexión con el DAC (${err.message}).`,
              );
          }
        }
      } catch (err) {
        // never let one bad frame kill the output loop; stay safe instead
        if (this.armed) this.disarm();
        this._error(`Error al generar el cuadro: ${err.message}`);
      }
      // always yield to the event loop: the UI, timers and a blackout tap must never wait on the output loop
      if (!wrote)
        await sleep(Math.max(0, 1000 / IDLE_FPS - (performance.now() - t0)));
      else await sleep(0);
    }
  }

  // ----- state out -----------------------------------------------------------------------------------------
  // Scene, cue objects and the cues array are replaced on change, never mutated, so they are shared, not cloned.
  getState() {
    return {
      armed: this.armed,
      simulated: !this.usbDacs.length,
      dacs: this.dacs.map((d) => ({
        index: d.index,
        name: d.name,
        kind: d.kind,
      })),
      scene: this.scene,
      settings: { ...this.settings },
      cues: this.cues,
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
      return data && typeof data === "object" && !Array.isArray(data)
        ? data
        : {};
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
