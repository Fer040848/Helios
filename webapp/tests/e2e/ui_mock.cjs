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
    let sock = null, connections = 0, blanked = false;
    const wire = (p) => p.routeWebSocket('**/ws', (ws) => {
      sock = ws; connections++;
      const push = () => ws.send(JSON.stringify({ type: 'state', state }));
      push();
      let t = 0;
      const timer = setInterval(() => ws.send(JSON.stringify(blanked ? { ...circleFrame(t++), strokes: [], blanked: true } : circleFrame(t++))), 50);
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
        else if (msg.type === 'tap') { state.bpm = 128; push(); }
      });
    });
    await wire(page);
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
    // box of a selector, or null when it is not rendered; "on screen" = fully inside the viewport
    const box = (p, sel) => p.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight };
    }, sel);
    const onScreen = (b) => !!b && b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.r <= b.vw + 0.5 && b.b <= b.vh + 0.5;
    // the arm / blackout control must be fully visible on every layout
    const armOnScreen = async (p, what) => assert(onScreen(await box(p, '#arm')), `${what}: arm / blackout control fully on screen`);

    await page.goto(server.url);
    await page.waitForFunction(() => !document.body.classList.contains('offline'));
    assert(connections === 1, 'page connects to /ws');
    assert(await page.locator('.cue').count() === 16, 'renders 16 cue slots');
    assert(await page.locator('.cue.empty').count() === 16 - state.cues.filter(Boolean).length, 'empty slots marked');
    assert(await page.locator('#patterns button').count() === state.patterns.length, 'pattern list from state');
    assert((await page.locator('#dac').textContent()) === 'SIMULADOR', 'SIMULADOR badge');

    await sleep(300);
    // lit = brighter than the static preview guides (grid, crosshair, range, scan area) can be: laser light only
    const lit = await page.evaluate(() => {
      const c = document.getElementById('preview'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) n++; return n;
    });
    assert(lit > 500, `preview has non-black pixels after frame (${lit})`);
    assert(Number(await page.locator('#fps').textContent()) > 0, 'fps shown from frame');
    await page.screenshot({ path: path.join(OUT, 'tab-cues.png') });
    await armOnScreen(page, 'phone portrait');
    assert(await page.locator('#livebar').isVisible() && await page.locator('#tab-cues').isVisible(), 'phone portrait: live bar shown, Cues is a tab');
    await page.screenshot({ path: path.join(OUT, 'redesign-phone-portrait.png') });

    // Live bar: a quick colour sends exactly a colour scene message and shows as selected once the state echoes it.
    await page.locator('#quick-colors [data-color="#ff0000"]').tap();
    await waitMsg((m) => m.type === 'scene' && JSON.stringify(m.scene) === '{"color":"#ff0000"}', 'live bar swatch sends {type:scene, scene:{color:"#ff0000"}}');
    await page.waitForSelector('#quick-colors [data-color="#ff0000"].on[aria-checked="true"]');
    assert(await page.locator('#quick-colors .on').count() === 1, 'live bar shows the current colour');
    // TAP sends a tap; the BPM readouts follow the state.
    await page.locator('#live-tap').tap();
    await waitMsg((m) => m.type === 'tap', 'live bar TAP sends {type:tap}');
    await page.waitForFunction(() => document.getElementById('live-bpm').textContent === '128' && document.getElementById('strip-bpm').textContent === '128');
    assert(true, 'live bar and status strip show the BPM from the state');
    // The effect chip names the current effect and opens the Efecto tab.
    assert((await page.locator('#fx-name').textContent()) === 'Ninguno', 'effect chip shows the current effect name');
    await page.locator('#fx-chip').tap();
    await page.waitForSelector('#page-fx:not([hidden])');
    assert((await page.locator('#tab-fx').getAttribute('aria-selected')) === 'true', 'effect chip opens the Efecto tab');
    await page.locator('#effects button', { hasText: 'Pulso' }).tap();
    await page.waitForFunction(() => document.getElementById('fx-name').textContent === 'Pulso');
    assert(true, 'effect chip follows the effect from the state');
    await tab('cues');

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
    await page.screenshot({ path: path.join(OUT, 'redesign-armed.png') });
    assert((await page.locator('#arm-state').textContent()) === 'EN VIVO', 'status strip shows the armed state');
    await touch('touchStart', ax, ay); await touch('touchEnd');
    await waitMsg((m) => m.type === 'blackout', 'tap while armed sends blackout');
    await page.waitForSelector('body:not(.armed)');
    assert((await page.locator('#arm-state').textContent()) === 'EN ESPERA', 'status strip shows standby after blackout');

    // Beam safety blanked the frame: the badge shows over the preview.
    blanked = true;
    await page.waitForSelector('#blank-badge', { state: 'visible' });
    await page.screenshot({ path: path.join(OUT, 'redesign-blanked.png') });
    blanked = false;
    await page.waitForSelector('#blank-badge', { state: 'hidden' });
    assert(true, 'blanked frames show the beam-safety badge, which clears afterwards');

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
    await page.screenshot({ path: path.join(OUT, 'redesign-phone-landscape.png') });
    await armOnScreen(page, 'phone landscape');
    {
      const [pv, live, grid] = [await box(page, '.preview-wrap'), await box(page, '#livebar'), await box(page, '#cue-grid')];
      assert(onScreen(live) && pv.r <= grid.x && await page.locator('#tab-cues').isVisible(), 'phone landscape: preview, arm and live bar left of the panels; Cues still a tab');
    }

    // Tablet (820x1180, touch): two columns - preview, arm, live bar and cues left; tabbed controls right.
    await page.setViewportSize({ width: 820, height: 1180 });
    await sleep(300);
    {
      const [pv, arm, live, grid, panel, tabs] = await Promise.all(['.preview-wrap', '#arm', '#livebar', '#cue-grid', '#panel', '.tabbar'].map((s) => box(page, s)));
      assert(grid && panel && onScreen(grid) && panel.w > 0, 'tablet: cue grid and control panel both shown (no Cues tab switch needed)');
      assert([pv, arm, live, grid].every((b) => b.r <= 410.5) && panel.x >= 409.5 && tabs.x >= 409.5, 'tablet: two columns (stage + cues left, tabs + panel right)');
      assert(tabs.y < panel.y && !(await page.locator('#tab-cues').isVisible()), 'tablet: tabs on top of the panel, no Cues tab');
      await armOnScreen(page, 'tablet');
      await tab('color');
      assert(await page.locator('#page-color').isVisible() && await page.locator('#cue-grid').isVisible(), 'tablet: switching tabs keeps the cue grid visible');
    }
    await page.screenshot({ path: path.join(OUT, 'redesign-tablet.png') });

    // Desktop (1440x900, mouse): three columns, cue grid and control panel visible at the same time.
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await desk.newPage();
    dp.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    dp.on('pageerror', (e) => errors.push(String(e)));
    await wire(dp);
    await dp.goto(server.url);
    await dp.waitForFunction(() => !document.body.classList.contains('offline'));
    await sleep(500);
    {
      const [pv, live, grid, panel, tabs] = await Promise.all(['.preview-wrap', '#livebar', '#cue-grid', '#panel', '.tabbar'].map((s) => box(dp, s)));
      assert(onScreen(grid) && onScreen(tabs) && panel.w > 0 && await dp.locator('#page-shape').isVisible(), 'desktop: cue grid and control panel are both visible at the same time');
      assert(pv.r <= grid.x && live.r <= grid.x && grid.r <= panel.x && grid.r <= tabs.x, 'desktop: three columns (preview | cues | controls)');
      assert(!(await dp.locator('#tab-cues').isVisible()) && (await dp.locator('#tab-shape').getAttribute('aria-selected')) === 'true', 'desktop: no Cues tab; the first control tab is open');
      assert(await dp.locator('.cue').count() === 16 && (await box(dp, '.cue[data-index="15"]')).b <= 900, 'desktop: all 16 cues on screen (4x4)');
      await armOnScreen(dp, 'desktop');
    }
    await dp.locator('.cue[data-index="2"]').click();
    await waitMsg((m) => m.type === 'cue' && m.index === 2, 'desktop: clicking a cue fires it');
    await dp.locator('[data-tab="fx"]').click();
    assert(await dp.locator('#page-fx').isVisible() && await dp.locator('#cue-grid').isVisible(), 'desktop: switching tabs keeps the cue grid visible');
    await dp.locator('[data-tab="shape"]').click();
    await sleep(300);
    await dp.screenshot({ path: path.join(OUT, 'redesign-desktop.png') });
    // keyboard safety still works with this layout: Space / Esc send blackout
    const before = sent.filter((m) => m.type === 'blackout').length;
    await dp.keyboard.press('Escape');
    await dp.keyboard.press('Space');
    await waitMsg(() => sent.filter((m) => m.type === 'blackout').length >= before + 2, 'desktop: Esc and Space send blackout');
    await desk.close();

    assert(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    console.log('UI MOCK OK');
  } finally {
    timers.forEach(clearInterval);
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
