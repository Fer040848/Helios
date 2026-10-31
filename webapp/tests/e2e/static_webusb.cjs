// End-to-end test of the published-site mode (e.g. dac.ferchx.com): static hosting, no Python server, the in-browser
// engine drives a (fake) Helios over WebUSB. Phone-sized browser with touch.
// Usage: node tests/e2e/static_webusb.cjs
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const { startStaticServer } = require('./mock_backend.cjs');

const STATIC = path.resolve(__dirname, '..', '..', 'static');
const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error('FAIL - ' + msg);
  console.log('ok - ' + msg);
}

// Injected before the page loads: a fake navigator.usb with one Helios that answers like the firmware.
const FAKE_USB = () => {
  const log = (window.__usbLog = []);
  let lastCmd = 0;
  const device = {
    vendorId: 0x1209, productId: 0xe500, productName: 'Helios Laser DAC', serialNumber: 'T1',
    opened: false, configuration: null,
    async open() { this.opened = true; },
    async selectConfiguration() { this.configuration = {}; },
    async claimInterface() {},
    async selectAlternateInterface() {},
    async close() { this.opened = false; },
    async transferOut(ep, data) {
      log.push({ ep, b0: data[0], b1: data[1], n: data.length, flags: data[data.length - 1] });
      if (ep === 6) lastCmd = data[0];
      return { status: 'ok' };
    },
    async transferIn() {
      await new Promise((r) => setTimeout(r, 2));
      const reply = lastCmd === 4 ? [0x84, 5, 0, 0, 0] : [0x83, 1];
      const buf = new Uint8Array(32);
      buf.set(reply);
      return { status: 'ok', data: new DataView(buf.buffer) };
    },
  };
  const listeners = {};
  Object.defineProperty(navigator, 'usb', {
    value: {
      getDevices: async () => [],
      requestDevice: async () => { window.__requested = true; return device; },
      addEventListener: (t, fn) => { listeners[t] = fn; },
    },
  });
};

(async () => {
  const server = await startStaticServer(STATIC, { api: false });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(FAKE_USB);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const tab = async (name) => { await page.locator(`[data-tab="${name}"]`).tap(); await sleep(250); };
    const usb = () => page.evaluate(() => window.__usbLog);

    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelectorAll('.cue').length === 16, null, { timeout: 5000 });
    assert((await page.locator('#dac').textContent()) === 'SIMULADOR', 'static site starts on the simulator');
    await sleep(500);
    const lit = await page.evaluate(() => {
      const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
      return n;
    });
    assert(lit > 200, `in-browser engine draws the preview (${lit} lit pixels)`);

    await tab('settings');
    assert((await page.locator('#rescan span').textContent()) === 'Conectar DAC por USB', 'WebUSB connect button');
    await page.locator('#rescan').tap();
    await page.waitForFunction(() => document.getElementById('dac').textContent !== 'SIMULADOR', null, { timeout: 3000 });
    assert(await page.evaluate(() => window.__requested), 'tap asks the browser for the Helios (requestDevice)');
    assert((await page.locator('#dac').textContent()).startsWith('Helios Laser DAC'), 'badge shows the USB DAC');
    await page.screenshot({ path: path.join(OUT, 'web-usb-settings.png') });
    assert((await usb()).filter((e) => e.ep === 2).length === 0, 'no frames while disarmed');

    await tab('cues');
    await page.locator('.cue[data-index="2"]').tap();
    const b = await page.locator('#arm').boundingBox();
    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2); await sleep(750); await touch('touchEnd');
    await page.waitForFunction(() => document.getElementById('arm-label').textContent.startsWith('EN VIVO'), null, { timeout: 3000 });
    await sleep(400);
    const frames = (await usb()).filter((e) => e.ep === 2);
    assert(frames.length > 3, `armed: frames go to the DAC over USB (${frames.length})`);
    assert(frames.every((f) => f.flags === 2 && (f.n - 5) % 7 === 0), 'frames are Helios-format with SINGLE_MODE');
    await page.screenshot({ path: path.join(OUT, 'web-usb-armed.png') });

    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2); await touch('touchEnd');
    await page.waitForFunction(() => !document.getElementById('arm-label').textContent.startsWith('EN VIVO'), null, { timeout: 3000 });
    await sleep(200);
    const log = await usb();
    const controls = log.filter((e) => e.ep === 6).map((e) => [e.b0, e.b1]);
    assert(JSON.stringify(controls.slice(-2)) === JSON.stringify([[1, 0], [2, 0]]), 'blackout sends Stop then closes the shutter');
    const count = log.filter((e) => e.ep === 2).length;
    await sleep(300);
    assert((await usb()).filter((e) => e.ep === 2).length === count, 'no frames after blackout');

    const noUsb = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await noUsb.addInitScript(() => Object.defineProperty(navigator, 'usb', { value: undefined }));
    await noUsb.goto(server.url);
    await noUsb.waitForFunction(() => document.querySelectorAll('.cue').length === 16, null, { timeout: 5000 });
    await noUsb.locator('[data-tab="settings"]').click();
    await sleep(200);
    assert(await noUsb.locator('#rescan').isDisabled(), 'without WebUSB (e.g. iPhone) the connect button is disabled');
    assert(/Chrome o Edge/.test(await noUsb.locator('#rescan-hint').textContent()), '...and the hint says to use Chrome or Edge');
    assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log('STATIC WEBUSB OK');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
