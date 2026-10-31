// Safety regressions of the in-browser backend + WebUSB driver (from the adversarial review of the WebUSB port).
// Run: node --test tests/js/safety.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as model from "../../static/engine/model.js";
import { HELIOS_FILTER } from "../../static/engine/helios-usb.js";
import { LocalBackend } from "../../static/engine/local.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await sleep(5);
  }
};

/** Fake Helios: answers like the firmware; can be made busy (status 0), silent (no status reply) or wedged (bulk). */
class FakeHelios {
  constructor(opts = {}) {
    Object.assign(this, { ...HELIOS_FILTER, productName: "Helios Laser DAC", opened: false, configuration: null });
    Object.assign(this, { busy: false, silent: false, wedgeBulk: false, ...opts });
    this.log = [];
    this.lastCmd = null;
  }
  async open() { this.opened = true; }
  async selectConfiguration() { this.configuration = {}; }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async close() { this.opened = false; this.log.push(["close"]); }
  transferOut(ep, data) {
    if (ep === 2 && this.wedgeBulk) return new Promise(() => {}); // NAKs forever
    this.log.push([ep, [...data.slice(0, 2)]]);
    if (ep === 6) this.lastCmd = data[0];
    return Promise.resolve({ status: "ok" });
  }
  transferIn() {
    if (this.silent && this.lastCmd === 0x03) return new Promise(() => {});
    const reply = this.lastCmd === 0x04 ? [0x84, 5, 0, 0, 0] : [0x83, this.busy ? 0 : 1];
    const buf = new Uint8Array(32);
    buf.set(reply);
    return new Promise((r) => setTimeout(() => r({ status: "ok", data: new DataView(buf.buffer) }), 1));
  }
  frames() { return this.log.filter(([ep]) => ep === 2).length; }
  controls() { return this.log.filter(([ep]) => ep === 6).map(([, d]) => d); }
  /** controls (and close) logged after the last status poll */
  afterLastStatus() {
    const i = this.log.map(([ep, d]) => ep === 6 && d[0] === 3).lastIndexOf(true);
    return this.log.slice(i + 1).filter(([ep]) => ep !== 2).map(([ep, d]) => (ep === "close" ? "close" : d));
  }
}

function makeBackend({ devices = [], doc = null, wakeLock = undefined } = {}) {
  const messages = [];
  const usb = {
    getDevices: async () => devices,
    requestDevice: async () => devices[0],
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
  };
  const backend = new LocalBackend({ onMessage: (m) => messages.push(m), onStatus: () => {}, usb, storage: null, doc, wakeLock });
  const errors = () => messages.filter((m) => m.type === "error").map((m) => m.message);
  return { backend, messages, usb, errors };
}

test("a freshly opened DAC is put in Stop + shutter-closed", async () => {
  const dev = new FakeHelios();
  const { backend } = makeBackend({ devices: [dev] });
  backend.start();
  await until(() => backend.usbDacs.length === 1);
  assert.deepEqual(dev.controls(), [[4, 0], [7, 11], [2, 0], [1, 0]]);
  await backend.stop();
});

test("a DAC dropped because it stopped answering still gets Stop + shutter-closed before close", async () => {
  const dev = new FakeHelios();
  const { backend, errors } = makeBackend({ devices: [dev] });
  backend.start();
  await until(() => backend.usbDacs.length === 1);
  backend.send({ type: "arm", armed: true });
  await until(() => dev.frames() > 2);
  dev.silent = true;
  await until(() => backend.usbDacs.length === 0, 3000);
  await until(() => dev.log.at(-1)[0] === "close");
  assert.equal(backend.armed, false);
  assert.deepEqual(dev.afterLastStatus(), [[2, 0], [1, 0], "close"]);
  assert.equal(errors().filter((e) => /DAC/.test(e)).length, 1);
  await backend.stop();
});

test("a DAC whose bulk endpoint wedges is dropped (no frozen loop) and the output blacks out", async () => {
  const dev = new FakeHelios();
  const { backend, errors } = makeBackend({ devices: [dev] });
  backend.start();
  await until(() => backend.usbDacs.length === 1);
  backend.send({ type: "arm", armed: true });
  await until(() => dev.frames() > 2);
  dev.wedgeBulk = true;
  await until(() => backend.usbDacs.length === 0, 3000);
  assert.equal(backend.armed, false);
  assert.match(errors().at(-1), /no responde/);
  const before = backend.fps;
  await sleep(150);
  assert.ok(backend.fps > 0 && before > 0, "render loop still running");
  await backend.stop();
});

test("blackout during a status poll: the queued frame is never sent", async () => {
  const dev = new FakeHelios();
  const { backend } = makeBackend({ devices: [dev] });
  backend.start();
  await until(() => backend.usbDacs.length === 1);
  dev.busy = true;
  backend.send({ type: "arm", armed: true });
  await sleep(30); // the write is polling a busy DAC
  backend.send({ type: "blackout" });
  dev.busy = false; // buffer frees right after the blackout tap
  await sleep(250);
  assert.equal(dev.frames(), 0, "no frame after blackout");
  assert.deepEqual(dev.controls().slice(-2), [[2, 0], [1, 0]]);
  await backend.stop();
});

test("plugging a DAC in while armed blacks out with a message and leaves the new DAC safe", async () => {
  const dev = new FakeHelios();
  const { backend, usb, errors } = makeBackend();
  backend.start();
  backend.send({ type: "arm", armed: true }); // on the simulator
  await sleep(50);
  usb.listeners.connect({ device: dev });
  await until(() => backend.usbDacs.length === 1);
  assert.equal(backend.armed, false);
  assert.match(errors().at(-1), /Se conectó un DAC/);
  await sleep(50);
  assert.equal(dev.frames(), 0);
  assert.deepEqual(dev.controls().slice(-2), [[2, 0], [1, 0]]);
  await backend.stop();
});

test("unplugging an armed DAC reports once, with the reconnect hint", async () => {
  const dev = new FakeHelios();
  const { backend, usb, errors } = makeBackend({ devices: [dev] });
  backend.start();
  await until(() => backend.usbDacs.length === 1);
  backend.send({ type: "arm", armed: true });
  await until(() => dev.frames() > 2);
  dev.silent = true; // the in-flight write will fail too
  usb.listeners.disconnect({ device: dev });
  await sleep(400);
  const dacErrors = errors().filter((e) => /DAC/.test(e));
  assert.equal(dacErrors.length, 1, dacErrors.join(" | "));
  assert.match(dacErrors[0], /desconectó.*La salida se apagó.*Conectar DAC por USB/);
  await backend.stop();
});

test("a wake lock granted after a quick blackout is released", async () => {
  let lock = null;
  const wakeLock = {
    request: () => new Promise((r) => setTimeout(() => r((lock = { released: false, release() { this.released = true; return Promise.resolve(); } })), 20)),
  };
  const { backend } = makeBackend({ wakeLock });
  backend.start();
  backend.send({ type: "arm", armed: true });
  backend.send({ type: "blackout" });
  await sleep(60);
  assert.ok(lock?.released, "lock released");
  assert.equal(backend.wakeLock, null);
  await backend.stop();
});

test("going to the background blacks out and explains it when the page is visible again", async () => {
  const doc = { hidden: false, addEventListener(t, fn) { this.fn = fn; } };
  const { backend, errors } = makeBackend({ doc });
  backend.start();
  backend.send({ type: "arm", armed: true });
  doc.hidden = true;
  doc.fn();
  assert.equal(backend.armed, false);
  assert.equal(errors().length, 0, "no toast while hidden");
  doc.hidden = false;
  doc.fn();
  assert.match(errors().at(-1), /segundo plano/);
  await backend.stop();
});

test("blocked site storage does not stop the backend from starting", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  try {
    const backend = new LocalBackend({ onMessage: () => {}, onStatus: () => {}, usb: null, doc: null });
    assert.equal(backend.storage, null);
    assert.equal(backend.cues.length, model.CUE_SLOTS);
  } finally {
    if (desc) Object.defineProperty(globalThis, "localStorage", desc);
    else delete globalThis.localStorage;
  }
});

test("lone surrogates become '?' in text and cue names (same as Python)", () => {
  assert.equal(model.mergeScene(model.SCENE_DEFAULTS, { text: "A\ud800B" }).text, "A?B");
  assert.equal(model.cleanCues([{ name: "x\udc00", scene: {} }])[0].name, "x?");
  assert.equal(model.mergeScene(model.SCENE_DEFAULTS, { text: "😀" }).text, "😀");
  assert.equal(model.mergeScene(model.SCENE_DEFAULTS, { color: "#ABCDEF\n" }).color, "#00ff00");
});

// ----- second review round ---------------------------------------------------------------------------------
class WedgeableHelios extends FakeHelios {
  transferOut(ep, data) {
    if (ep === 6 && this.wedgeControl) return new Promise(() => {}); // control endpoint NAKs forever
    return super.transferOut(ep, data);
  }
}

test("a DAC that does not confirm the blackout is dropped with a warning, not left looking healthy", async () => {
  const a = new FakeHelios(), b = new WedgeableHelios();
  const { backend, errors } = makeBackend({ devices: [a, b] });
  backend.start();
  await until(() => backend.usbDacs.length === 2);
  backend.send({ type: "arm", armed: true });
  await until(() => a.frames() > 2 && b.frames() > 2);
  b.wedgeControl = true;
  backend.send({ type: "blackout" });
  await until(() => backend.usbDacs.length === 1, 3000);
  assert.equal(backend.usbDacs[0].device, a);
  assert.equal(backend.armed, false);
  assert.ok(errors().some((e) => /no confirmó el apagado/.test(e)), errors().join(" | "));
  await backend.stop();
});

test("a DAC that does not confirm arming is dropped and the output stays off", async () => {
  const dev = new WedgeableHelios();
  const { backend, errors } = makeBackend({ devices: [dev] });
  backend.start();
  await until(() => backend.usbDacs.length === 1);
  dev.wedgeControl = true;
  backend.send({ type: "arm", armed: true });
  await until(() => backend.usbDacs.length === 0, 3000);
  assert.equal(backend.armed, false);
  assert.match(errors().at(-1), /no respondió al encender/);
  await backend.stop();
});

test("DAC names are unique and stable, also when added together or after an unplug", async () => {
  const a = new FakeHelios(), b = new FakeHelios(), c = new FakeHelios();
  const { backend, usb } = makeBackend({ devices: [a, b] });
  backend.start();
  await until(() => backend.usbDacs.length === 2);
  const names = backend.usbDacs.map((d) => d.name);
  assert.equal(new Set(names).size, 2, names.join(", "));
  usb.listeners.disconnect({ device: a });
  usb.listeners.connect({ device: c });
  await until(() => backend.usbDacs.length === 2);
  const after = backend.getState().dacs.map((d) => d.name);
  assert.equal(new Set(after).size, 2, after.join(", "));
  assert.ok(after.includes(names[1]), "the remaining DAC keeps its name");
  await backend.stop();
});

test("a stored blob with Object.prototype keys does not stop the app from starting", () => {
  const blob = JSON.stringify({ settings: { toString: 1, constructor: 2, brightness: 0.5 }, cues: [{ name: "a", scene: { constructor: 1, hasOwnProperty: 2, pattern: "star" } }] });
  const storage = { getItem: () => blob, setItem() {} };
  const backend = new LocalBackend({ onMessage: () => {}, onStatus: () => {}, usb: null, storage, doc: null });
  assert.equal(backend.settings.brightness, 0.5);
  assert.equal(backend.cues[0].scene.pattern, "star");
  assert.equal(Object.prototype.hasOwnProperty.call(backend.settings, "toString"), false);
});

test("the published JS avoids features missing from older phones (Safari 15)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../../static/", import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".js")), ...readdirSync(new URL("engine/", dir)).map((f) => `engine/${f}`)];
  const banned = [
    [/\(\?<[=!]/, "regex lookbehind (Safari 16.4)"],
    [/AbortSignal\.timeout/, "AbortSignal.timeout (Safari 16)"],
    [/Object\.hasOwn\(/, "Object.hasOwn (Safari 15.4)"],
    [/\.at\(/, "Array/String .at() (Safari 15.4)"],
    [/structuredClone|findLast|toWellFormed/, "newer built-ins"],
  ];
  for (const f of files) {
    const code = readFileSync(new URL(f, dir), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const [re, what] of banned) assert.ok(!re.test(code), `${f} uses ${what}`);
  }
  assert.ok(files.length >= 9);
});
