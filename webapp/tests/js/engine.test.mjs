// JavaScript engine tests: parity with the Python engine, WebUSB packing, and LocalBackend safety rules.
// Run: node --test tests/js/   (needs python3 on PATH for the parity test, or PYTHON=/path/to/python)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Clocks, compose } from "../../static/engine/effects.js";
import { buildFrame, isLit, MAX_POINTS } from "../../static/engine/rasterize.js";
import * as model from "../../static/engine/model.js";
import { packFrame, HELIOS_FILTER } from "../../static/engine/helios-usb.js";
import { LocalBackend } from "../../static/engine/local.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scene = (kw) => model.mergeScene(model.SCENE_DEFAULTS, kw);

test("JS engine output matches the Python engine point for point", () => {
  const script = fileURLToPath(new URL("./make_parity.py", import.meta.url));
  const cases = JSON.parse(execFileSync(process.env.PYTHON || "python3", [script], { maxBuffer: 1 << 28 }));
  assert.ok(cases.length >= 100);
  for (const c of cases) {
    const { preview, points } = buildFrame(compose(c.scene, Object.assign(new Clocks(), c.clocks)), c.settings);
    const label = `${c.scene.pattern}/${c.scene.effect}/${c.scene.colorMode}`;
    assert.equal(points.length, c.points.length, label);
    assert.equal(preview.length, c.preview, label);
    points.forEach((p, i) => p.forEach((v, j) => assert.ok(Math.abs(v - c.points[i][j]) < 1e-9, `${label} #${i}`)));
  }
});

test("frames end blanked, beam safety blanks a dot, brightness and scan size apply", () => {
  const settings = { ...model.SETTINGS_DEFAULTS };
  const { points } = buildFrame(compose(scene({ pattern: "circle", color: "#ffffff" }), new Clocks()), settings);
  assert.ok(!isLit(points[points.length - 1]));
  assert.ok(Math.max(...points.map((p) => p[2])) <= settings.brightness + 1e-12);
  assert.ok(Math.max(...points.map((p) => Math.abs(p[0]))) <= settings.scanSize * 0.6 + 1e-9);
  const dot = buildFrame([{ points: [[0.1, 0.1, 1, 1, 1]], closed: false }], settings);
  assert.deepEqual(dot.preview, []);
  assert.ok(!dot.points.some(isLit));
  assert.ok(buildFrame([{ points: [[0.1, 0.1, 1, 1, 1]], closed: false }], { ...settings, beamSafety: false }).points.some(isLit));
  assert.ok(points.length <= MAX_POINTS);
});

test("packFrame follows the Helios USB format", () => {
  const buf = packFrame([[-1, 1, 1, 0, 0], [1, -1, 0, 0, 0]], 30000);
  assert.equal(buf.length, 2 * 7 + 5);
  assert.deepEqual([...buf.slice(0, 7)], [0x00, 0x0f, 0xff, 255, 0, 0, 255]); // x=0, y=0xFFF, red, i=255
  assert.deepEqual([...buf.slice(7, 14)], [0xff, 0xf0, 0x00, 0, 0, 0, 0]); // x=0xFFF, y=0, blank, i=0
  assert.deepEqual([...buf.slice(14)], [30000 & 0xff, 30000 >> 8, 2, 0, 2]); // pps, count, SINGLE_MODE
  const quirk = packFrame(Array.from({ length: 109 }, () => [0, 0, 0, 0, 0]), 30000); // (109 - 45) % 64 === 0
  assert.equal(quirk.length, 108 * 7 + 5);
});

// ----- LocalBackend with a fake WebUSB Helios ---------------------------------------------------------------
class FakeDevice {
  constructor({ silent = false } = {}) {
    Object.assign(this, { ...HELIOS_FILTER, productName: "Helios Laser DAC", opened: false, configuration: null, silent });
    this.log = [];
    this.lastCmd = null;
  }
  async open() { this.opened = true; }
  async selectConfiguration() { this.configuration = {}; }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async close() { this.opened = false; }
  async transferOut(ep, data) {
    this.log.push([ep, [...data.slice(0, 2)], data.length]);
    if (ep === 6) this.lastCmd = data[0];
    return { status: "ok" };
  }
  transferIn() {
    if (this.silent && this.lastCmd === 0x03) return new Promise(() => {}); // never answers
    const reply = this.lastCmd === 0x04 ? [0x84, 5, 0, 0, 0] : [0x83, 1];
    return Promise.resolve({ status: "ok", data: new DataView(new Uint8Array([...reply, ...new Array(32 - reply.length).fill(0)]).buffer) });
  }
  frames() { return this.log.filter(([ep]) => ep === 2); }
  controls() { return this.log.filter(([ep]) => ep === 6).map(([, d]) => d); }
}

function makeBackend(device) {
  const messages = [];
  const usb = {
    getDevices: async () => (device ? [device] : []),
    requestDevice: async () => device,
    addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
  };
  const backend = new LocalBackend({ onMessage: (m) => messages.push(m), onStatus: () => {}, usb, storage: null, doc: null });
  return { backend, messages, usb };
}

test("disarmed writes no frames; armed writes SINGLE_MODE frames; blackout stops and closes the shutter last", async () => {
  const dev = new FakeDevice();
  const { backend, messages } = makeBackend(dev);
  backend.start();
  await sleep(150);
  assert.equal(backend.getState().simulated, false);
  assert.equal(backend.getState().armed, false);
  assert.equal(dev.frames().length, 0, "nothing written while disarmed");
  backend.send({ type: "arm", armed: true });
  await sleep(200);
  assert.ok(dev.frames().length > 0, "frames written when armed");
  backend.send({ type: "blackout" });
  await sleep(100);
  const after = dev.frames().length;
  const tail = dev.controls().slice(-2);
  assert.deepEqual(tail, [[0x01, 0], [0x02, 0]], "Stop then shutter closed");
  await sleep(150);
  assert.equal(dev.frames().length, after, "no frames after blackout");
  assert.ok(messages.some((m) => m.type === "frame" && m.strokes.length));
  await backend.stop();
});

test("unplugging the DAC while armed blacks out and falls back to the simulator", async () => {
  const dev = new FakeDevice();
  const { backend, messages, usb } = makeBackend(dev);
  backend.start();
  await sleep(100);
  backend.send({ type: "arm", armed: true });
  await sleep(100);
  usb.listeners.disconnect({ device: dev });
  assert.equal(backend.armed, false);
  assert.equal(backend.getState().simulated, true);
  assert.ok(messages.some((m) => m.type === "error" && /desconect/.test(m.message)));
  await backend.stop();
});

test("a DAC that stops answering is dropped and the output disarmed", async () => {
  const dev = new FakeDevice({ silent: true });
  const { backend, messages } = makeBackend(dev);
  backend.start();
  await sleep(100);
  backend.send({ type: "arm", armed: true });
  await sleep(600);
  assert.equal(backend.armed, false);
  assert.equal(backend.getState().simulated, true);
  assert.ok(messages.some((m) => m.type === "error" && /responde/.test(m.message)));
  await backend.stop();
});

test("protocol errors, rescan while armed, and browsers without WebUSB", async () => {
  const { backend, messages } = makeBackend(null);
  backend.start();
  for (const bad of [null, [1], { type: "nope" }, { type: "cue", index: 99 }, { type: "arm" }]) backend.send(bad);
  assert.equal(messages.filter((m) => m.type === "error").length, 5);
  backend.send({ type: "arm", armed: true });
  backend.send({ type: "rescan" });
  assert.match(messages.at(-1).message, /Apaga la salida/);
  backend.send({ type: "blackout" });
  backend.send({ type: "cue", index: 2 });
  assert.equal(backend.getState().activeCue, 2);
  assert.equal(backend.getState().scene.pattern, "star");
  const noUsb = new LocalBackend({ onMessage: (m) => messages.push(m), onStatus: () => {}, usb: undefined, storage: null, doc: null });
  noUsb.send({ type: "rescan" });
  assert.match(messages.at(-1).message, /Chrome o Edge/);
  await backend.stop();
});
