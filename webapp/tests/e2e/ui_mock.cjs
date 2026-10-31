// UI test against a mocked backend: node webapp/tests/e2e/ui_mock.cjs  ->  last line "UI MOCK OK".
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { startStaticServer, makeState, circleFrame } = require('./mock_backend.cjs');

const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, what) { if (!cond) throw new Error(`ASSERT FAILED: ${what}`); console.log(`ok - ${what}`); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer(path.resolve(__dirname, '../../static'));
  const browser = await chromium.launch();
  const timers = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    const state = makeState();
    const sent = [];
    let sock = null, connections = 0;
    await page.routeWebSocket('**/ws', (ws) => {
      sock = ws; connections++;
      const push = () => ws.send(JSON.stringify({ type: 'state', state }));
      push();
      let t = 0;
      const timer = setInterval(() => ws.send(JSON.stringify(circleFrame(t++))), 50);
      timers.push(timer);
      ws.onClose(() => clearInterval(timer));
      ws.onMessage((raw) => {
        const msg = JSON.parse(raw);
        sent.push(msg);
        if (msg.type === 'arm') { state.armed = !!msg.armed; push(); }
        else if (msg.type === 'blackout') { state.armed = false; push(); }
        else if (msg.type === 'scene') { Object.assign(state.scene, msg.scene); state.activeCue = null; push(); }
        else if (msg.type === 'settings') { Object.assign(state.settings, msg.settings); push(); }
        else if (msg.type === 'cue' && state.cues[msg.index]) { Object.assign(state.scene, state.cues[msg.index].scene); state.activeCue = msg.index; push(); }
      });
    });
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const center = async (sel) => { await page.locator(sel).scrollIntoViewIfNeeded(); await sleep(100); const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2, b]; };
    const find = (pred) => sent.find(pred);
    async function waitMsg(pred, what, ms = 2000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (find(pred)) return assert(true, what); await sleep(25); }
      assert(false, what);
    }
    const tab = async (name) => { await page.locator(`[data-tab="${name}"]`).tap(); await sleep(150); };

    await page.goto(server.url);
    await page.waitForFunction(() => !document.body.classList.contains('offline'));
    assert(connections === 1, 'page connects to /ws');
    assert(await page.locator('.cue').count() === 16, 'renders 16 cue slots');
    assert(await page.locator('.cue.empty').count() === 16 - state.cues.filter(Boolean).length, 'empty slots marked');
    assert(await page.locator('#patterns button').count() === state.patterns.length, 'pattern list from state');
    assert((await page.locator('#dac').textContent()) === 'SIMULADOR', 'SIMULADOR badge');

    await sleep(300);
    const lit = await page.evaluate(() => {
      const c = document.getElementById('preview'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++; return n;
    });
    assert(lit > 500, `preview has non-black pixels after frame (${lit})`);
    assert(Number(await page.locator('#fps').textContent()) > 0, 'fps shown from frame');
    await page.screenshot({ path: path.join(OUT, 'tab-cues.png') });

    await page.locator('.cue[data-index="0"]').tap();
    await waitMsg((m) => m.type === 'cue' && m.index === 0, 'tapping cue 0 sends {type:cue,index:0}');
    await page.waitForSelector('.cue[data-index="0"].active');

    // Arm: short tap must not arm; a 700 ms hold must.
    const [ax, ay] = await center('#arm');
    await touch('touchStart', ax, ay); await sleep(120); await touch('touchEnd');
    await sleep(800);
    assert(!find((m) => m.type === 'arm'), 'short tap does not send arm');
    await touch('touchStart', ax, ay); await sleep(700); await touch('touchEnd');
    await waitMsg((m) => m.type === 'arm' && m.armed === true, '700 ms hold sends arm true');
    await page.waitForSelector('body.armed');
    assert((await page.locator('#arm-label').textContent()).startsWith('EN VIVO'), 'armed label from server state');
    await page.screenshot({ path: path.join(OUT, 'armed.png') });
    await touch('touchStart', ax, ay); await touch('touchEnd');
    await waitMsg((m) => m.type === 'blackout', 'tap while armed sends blackout');
    await page.waitForSelector('body:not(.armed)');

    // Forma: size slider drag.
    await tab('shape');
    await page.screenshot({ path: path.join(OUT, 'tab-shape.png') });
    const [, sy, sb] = await center('[data-key="scene.size"] input');
    await touch('touchStart', sb.x + sb.width * 0.6, sy);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', sb.x + sb.width * (0.6 - i * 0.04), sy); await sleep(30); }
    await touch('touchEnd');
    await waitMsg((m) => m.type === 'scene' && typeof m.scene.size === 'number', 'moving size slider sends scene.size');
    // State from server updates an untouched control.
    await sleep(500);
    state.scene.rotation = 45; sock.send(JSON.stringify({ type: 'state', state }));
    await page.waitForFunction(() => document.querySelector('[data-key="scene.rotation"] output').textContent === '45°');
    assert(true, 'incoming state updates slider value');

    await tab('color'); await page.screenshot({ path: path.join(OUT, 'tab-color.png') });
    await tab('fx'); await page.screenshot({ path: path.join(OUT, 'tab-fx.png') });

    // Texto.
    await tab('text');
    await page.locator('#text-input').fill('Laser');
    await waitMsg((m) => m.type === 'scene' && m.scene.pattern === 'text' && m.scene.text === 'Laser', 'typing sends pattern text');
    await page.locator('#text-input').blur();
    await page.screenshot({ path: path.join(OUT, 'tab-text.png') });

    // Dibujo.
    await tab('draw');
    const [, , db] = await center('#draw');
    await touch('touchStart', db.x + db.width * 0.2, db.y + db.height * 0.7);
    for (let i = 1; i <= 12; i++) { await touch('touchMove', db.x + db.width * (0.2 + i * 0.05), db.y + db.height * (0.7 - i * 0.04)); await sleep(16); }
    await touch('touchEnd');
    await waitMsg((m) => m.type === 'scene' && m.scene.pattern === 'drawing' && m.scene.drawing.length >= 1 && m.scene.drawing[0].length >= 2
      && m.scene.drawing.flat().every(([x, y]) => x >= -1 && x <= 1 && y >= -1 && y <= 1), 'drawing sends pattern drawing with a stroke in [-1,1]');
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, 'tab-draw.png') });

    // Ajustes.
    await tab('settings');
    await page.screenshot({ path: path.join(OUT, 'tab-settings.png') });
    await page.locator('label:has(#invert-x)').tap();
    await waitMsg((m) => m.type === 'settings' && m.settings.invertX === true, 'toggling invertX sends settings');

    // Server error -> toast.
    sock.send(JSON.stringify({ type: 'error', message: 'Mensaje no válido' }));
    await page.waitForSelector('#toast:not([hidden]):has-text("Mensaje no válido")');
    assert(true, 'error message shows a toast');

    // Disconnect -> banner, then automatic reconnect.
    sock.close();
    await page.waitForSelector('#banner:not([hidden])');
    assert(true, 'disconnect shows reconnecting banner');
    await page.waitForFunction(() => !document.body.classList.contains('offline'), null, { timeout: 4000 });
    assert(connections === 2, 'reconnects automatically');

    await tab('cues');
    await page.setViewportSize({ width: 844, height: 390 });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'landscape.png') });

    assert(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    console.log('UI MOCK OK');
  } finally {
    timers.forEach(clearInterval);
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
