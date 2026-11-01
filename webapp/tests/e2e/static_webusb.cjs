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

    // Laser light in the preview: pixels brighter than the static guides (grid, crosshair, range, scan area) can be.
    const litPixels = () => page.evaluate(() => {
      const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) n++;
      return n;
    });
    // Cue thumbnails: per filled tile, the number of lit pixels and a hash of the pixels (null for empty slots).
    const thumbs = (p = page) => p.evaluate(() => [...document.querySelectorAll('.cue')].map((b) => {
      const c = b.querySelector('canvas.thumb');
      if (b.classList.contains('empty') || !c || !c.width) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0, hash = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] + d[i + 1] + d[i + 2];
        if (v > 60) lit++;
        hash = (Math.imul(hash, 31) + v) | 0;
      }
      return { lit, hash };
    }));
    const changed = (a, b) => a.filter((t, i) => t && b[i] && t.hash !== b[i].hash).length;
    const thumbRenders = (p = page) => p.evaluate(async () => (await import('/static/thumbs.js')).stats.renders);
    const setRange = (key, v) => page.evaluate(([k, v]) => {
      const input = document.querySelector(`[data-key="${k}"] input`);
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, [key, v]);

    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelectorAll('.cue').length === 16, null, { timeout: 5000 });
    // the cue buttons exist before the engine has loaded: wait for its first state
    await page.waitForFunction(() => !document.body.classList.contains('offline'), null, { timeout: 5000 });
    assert((await page.locator('#dac').textContent()) === 'SIMULADOR', 'static site starts on the simulator');
    await sleep(500);
    const lit = await litPixels();
    assert(lit > 200, `in-browser engine draws the preview (${lit} lit pixels)`);
    assert((await page.locator('#scan-label').textContent()) === 'ÁREA DE ESCANEO 80%', 'scan-area label shows the scan size (80%)');
    assert(await page.locator('#blank-badge').isHidden(), 'no beam-safety badge while the frame is drawn');

    // Cue thumbnails: the filled cues show their own live, animated figure.
    const th0 = await thumbs();
    const litTiles = th0.filter((t) => t && t.lit >= 10).length;
    assert(litTiles >= 10, `thumbnails: ${litTiles} filled cue tiles draw their figure`);
    await sleep(500);
    const moving = changed(th0, await thumbs());
    assert(moving >= 6, `thumbnails animate while disarmed (${moving} of ${litTiles} changed in 0.5 s)`);
    await page.screenshot({ path: path.join(OUT, 'web-usb-cues.png') });

    // Beam safety: a collapsed shape (size 0) is blanked and the preview says so; a normal size brings it back.
    await tab('shape');
    await setRange('scene.size', 0);
    await page.waitForSelector('#blank-badge', { state: 'visible', timeout: 3000 });
    assert((await page.locator('#blank-badge').textContent()) === 'PROTECCIÓN DE HAZ — CUADRO APAGADO', 'size 0: beam-safety badge appears');
    await sleep(200);
    const dark = await litPixels();
    assert(dark === 0, `blanked frame: the preview shows only the guides (${dark} lit pixels)`);
    await page.screenshot({ path: path.join(OUT, 'web-usb-blanked.png') });
    await setRange('scene.size', 0.6);
    await page.waitForSelector('#blank-badge', { state: 'hidden', timeout: 3000 });
    assert(true, 'size 0.6: beam-safety badge disappears');
    await sleep(200);
    assert((await litPixels()) > 200, 'size 0.6: the preview draws the shape again');

    await tab('settings');
    await setRange('settings.scanSize', 0.5);
    await page.waitForFunction(() => document.getElementById('scan-label').textContent === 'ÁREA DE ESCANEO 50%', null, { timeout: 3000 });
    assert(true, 'scan-area label follows the scan size (50%)');
    await page.screenshot({ path: path.join(OUT, 'web-usb-scan50.png') });
    await setRange('settings.scanSize', 0.8);
    await page.waitForFunction(() => document.getElementById('scan-label').textContent === 'ÁREA DE ESCANEO 80%', null, { timeout: 3000 });

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
    // armed in WebUSB mode: the thumbnails freeze so nothing competes with the output loop on the main thread
    const [armedThumbs, armedRenders] = [await thumbs(), await thumbRenders()];
    await sleep(600);
    assert(changed(armedThumbs, await thumbs()) === 0 && (await thumbRenders()) === armedRenders,
      'armed (WebUSB): cue thumbnails stop updating');
    assert(armedThumbs.filter((t) => t && t.lit >= 10).length >= 10, 'armed (WebUSB): thumbnails keep their last frame');

    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2); await touch('touchEnd');
    await page.waitForFunction(() => !document.getElementById('arm-label').textContent.startsWith('EN VIVO'), null, { timeout: 3000 });
    await sleep(200);
    const log = await usb();
    const controls = log.filter((e) => e.ep === 6).map((e) => [e.b0, e.b1]);
    assert(JSON.stringify(controls.slice(-2)) === JSON.stringify([[2, 0], [1, 0]]), 'blackout closes the shutter, then sends Stop');
    const count = log.filter((e) => e.ep === 2).length;
    await sleep(300);
    assert((await usb()).filter((e) => e.ep === 2).length === count, 'no frames after blackout');
    const after = await thumbs();
    await sleep(500);
    assert(changed(after, await thumbs()) >= 6, 'disarmed again: thumbnails animate again');

    // Cost of the thumbnail scheduler with all 16 slots filled (heavy figures included), every tile on screen.
    const heavy = (scene) => ({ name: 'Pesado', scene });
    const drawing = [Array.from({ length: 2000 }, (_, i) => [(0.1 + 0.8 * i / 2000) * Math.cos(i * 0.02), (0.1 + 0.8 * i / 2000) * Math.sin(i * 0.02)])]; // a finger spiral, max points
    const cues16 = [
      ...[['circle', '#00ff00'], ['tunnel'], ['star', '#ffff00'], ['wave', '#0088ff'], ['text', '#ff00ff'], ['fan', '#00ffff'],
        ['lissajous'], ['heart', '#ff0000'], ['grid', '#00ff00'], ['spiral']].map(([pattern, color]) =>
        ({ name: pattern, scene: color ? { pattern, color, spin: 45 } : { pattern, colorMode: 'rainbow', spin: 45 } })),
      heavy({ pattern: 'text', text: 'LASER SHOW HELIOS WEB CONTROL 0123456789 ÑANDÚ ÁÉÍÓÚ ABCDEFGHIJKLMNOP', colorMode: 'rainbow', mirror: 'quad', textMode: 'scroll' }),
      heavy({ pattern: 'flower', colorMode: 'rainbow', mirror: 'quad', effect: 'wave', effectAmount: 1 }),
      heavy({ pattern: 'drawing', drawing, colorMode: 'rainbow', effect: 'wobble' }),
      heavy({ pattern: 'grid', colorMode: 'rainbow', mirror: 'quad', effect: 'wave' }),
      heavy({ pattern: 'tunnel', colorMode: 'rainbow', mirror: 'h', effect: 'zoom', spin: 120 }),
      heavy({ pattern: 'lissajous', colorMode: 'beat', effect: 'drawOn', beatSync: true }),
    ];
    const perfCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await perfCtx.addInitScript((cues) => localStorage.setItem('helios-web/v1', JSON.stringify({ cues })), cues16);
    const perf = await perfCtx.newPage();
    perf.on('pageerror', (e) => errors.push(String(e)));
    await perf.goto(server.url);
    await perf.waitForFunction(() => document.querySelectorAll('.cue:not(.empty)').length === 16, null, { timeout: 5000 });
    await sleep(1000); // warm up (JIT, first frames)
    await perf.evaluate(async () => Object.assign((await import('/static/thumbs.js')).stats, { ticks: 0, renders: 0, busyMs: 0, maxMs: 0 }));
    await sleep(3000);
    const st = await perf.evaluate(async () => ({ ...(await import('/static/thumbs.js')).stats }));
    const avgTick = st.busyMs / st.ticks, perRender = st.busyMs / st.renders;
    console.log(`# thumbnail scheduler, 16 cues: ${st.ticks} ticks in 3 s, ${avgTick.toFixed(2)} ms/tick avg, ` +
      `${st.maxMs.toFixed(1)} ms max, ${(st.renders / st.ticks).toFixed(1)} renders/tick, ${perRender.toFixed(2)} ms/render, ` +
      `${(st.realMs / st.ticks).toFixed(2)} ms/tick real (drawing + raster and commit of the changed canvases)`);
    assert(avgTick < 6, `one scheduler tick costs under 6 ms on average (${avgTick.toFixed(2)} ms)`);
    assert(st.renders / 3 >= 16 * 4, `16 thumbnails keep animating (${(st.renders / 3 / 16).toFixed(1)} fps each)`);
    assert((await thumbs(perf)).filter((t) => t && t.lit >= 10).length >= 15, '16 cues: the thumbnails draw their figures');
    await perf.screenshot({ path: path.join(OUT, 'web-usb-cues16.png') });
    await perfCtx.close();

    // Slow device (4x CPU throttle, desktop 1440x900 at 2x, all 16 tiles on screen, disarmed): the thumbnails' share
    // of the main thread, measured as the busy time with them minus the busy time with thumbs.js blocked, must stay
    // bounded (the scheduler idles 5x the real cost of each tick: ~17%). Counting only the drawing calls it was ~50%.
    const busyShare = async (blockThumbs) => {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await c.addInitScript((cues) => localStorage.setItem('helios-web/v1', JSON.stringify({ cues })), cues16);
      if (blockThumbs) await c.route('**/thumbs.js', (r) => r.abort());
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(server.url);
      await p.waitForFunction(() => document.querySelectorAll('.cue:not(.empty)').length === 16, null, { timeout: 5000 });
      const s = await c.newCDPSession(p);
      await s.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await s.send('Performance.enable');
      await sleep(1500);
      const taskTime = async () => (await s.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
      const [a, t0] = [await taskTime(), Date.now()];
      await sleep(4000);
      const share = (await taskTime() - a) / ((Date.now() - t0) / 1000);
      await c.close();
      return share;
    };
    const [withThumbs, without] = [await busyShare(false), await busyShare(true)];
    console.log(`# 4x CPU throttle, 16 cues: main thread ${(withThumbs * 100).toFixed(0)}% busy with thumbnails, ${(without * 100).toFixed(0)}% without`);
    assert(withThumbs - without <= 0.32, `slow device: the thumbnails take at most ~1/3 of the main thread (${((withThumbs - without) * 100).toFixed(0)}%)`);

    const noUsb = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })).newPage();
    await noUsb.addInitScript(() => Object.defineProperty(navigator, 'usb', { value: undefined }));
    await noUsb.goto(server.url);
    await noUsb.waitForFunction(() => document.querySelectorAll('.cue').length === 16, null, { timeout: 5000 });
    await noUsb.waitForFunction(() => !document.body.classList.contains('offline'), null, { timeout: 5000 });
    await sleep(500);
    const still = await thumbs(noUsb);
    await sleep(500);
    assert(still.filter((t) => t && t.lit >= 10).length >= 10 && changed(still, await thumbs(noUsb)) === 0,
      'prefers-reduced-motion: thumbnails are static frames');
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
