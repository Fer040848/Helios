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
    let sock = null, connections = 0, blanked = false, refuse = false;
    const wire = (p) => p.routeWebSocket('**/ws', (ws) => {
      if (refuse) { ws.close(); return; } // a server that is down: the UI stays offline and keeps retrying
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
    const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
    // WCAG contrast of an element's text against the first opaque background behind it
    const contrast = (p, sel) => p.evaluate((s) => {
      const el = document.querySelector(s);
      const rgb = (c) => c.match(/[\d.]+/g).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
        .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      let bg = [0, 0, 0];
      for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length < 4 || c[3] > 0) { bg = c; break; } }
      const [hi, lo] = [lum(rgb(getComputedStyle(el).color)), lum(bg)].sort((a, b) => b - a);
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    }, sel);
    const aa = async (p, sel, what) => { const c = await contrast(p, sel); assert(c >= 4.5, `${what}: text contrast ${c}:1 >= 4.5:1 (WCAG AA)`); };
    // Running CSS animations (not the one-shot 0.2 s transitions) of properties the compositor cannot animate: each one
    // costs a main-thread frame per vsync, and in WebUSB mode the output loop shares that thread. opacity and transform
    // are fine.
    const mainThreadAnimations = (p) => p.evaluate(() => document.getAnimations()
      .filter((a) => !(typeof CSSTransition === 'function' && a instanceof CSSTransition))
      .flatMap((a) => (a.effect?.getKeyframes?.() || []).flatMap((k) => Object.keys(k)))
      .filter((k) => !['offset', 'computedOffset', 'easing', 'composite', 'opacity', 'transform'].includes(k)));
    const litPreview = (p) => p.evaluate(() => {
      const c = document.getElementById('preview'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) n++; return n;
    });

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

    // Live bar: one tap on a quick colour = that colour on the laser: a single scene message with the colour and the solid
    // colour mode; it shows as selected once the state echoes it.
    await page.locator('#quick-colors [data-color="#ff0000"]').tap();
    await waitMsg((m) => m.type === 'scene' && JSON.stringify(m.scene) === '{"color":"#ff0000","colorMode":"solid"}', 'live bar swatch sends {type:scene, scene:{color:"#ff0000", colorMode:"solid"}}');
    await page.waitForSelector('#quick-colors [data-color="#ff0000"].on[aria-checked="true"]');
    assert(await page.locator('#quick-colors .on').count() === 1, 'live bar shows the current colour');
    // Non-solid colour mode (cue 2 "Túnel arcoíris" is rainbow): the base colour is not what the laser shows, so no quick
    // colour is marked; a tap switches back to solid in that colour.
    await page.locator('.cue[data-index="1"]').tap();
    await waitMsg((m) => m.type === 'cue' && m.index === 1, 'tapping cue 2 (rainbow) sends {type:cue,index:1}');
    await page.waitForFunction(() => document.querySelectorAll('#quick-colors .on, #quick-colors [aria-checked="true"]').length === 0);
    assert(true, 'rainbow mode: no quick colour shows as selected');
    await page.locator('#quick-colors [data-color="#00ffff"]').tap();
    await waitMsg((m) => m.type === 'scene' && m.scene.color === '#00ffff' && m.scene.colorMode === 'solid', 'rainbow mode: a quick colour sends the colour with colorMode solid');
    await page.waitForFunction(() => document.querySelector('#quick-colors [data-color="#00ffff"]').classList.contains('on'));
    assert(state.scene.colorMode === 'solid' && state.scene.color === '#00ffff', 'rainbow mode: after the tap the scene is solid cyan');
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
    await aa(page, '#arm-label', 'armed: arm label "EN VIVO — TOCA PARA APAGAR"');
    await aa(page, '#arm-state', 'armed: status strip chip "EN VIVO"');
    await aa(page, '.live-tag', 'armed: preview tag "EN VIVO"');
    {
      const anim = await mainThreadAnimations(page);
      assert(anim.length === 0, `armed: no running animation of a non-compositable property (${anim.join(', ') || 'none'})`);
    }
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

    // Phone portrait sizes (in-browser viewports with toolbars included): the arm, the quick colours and the live bar
    // span the stage; colour and segmented targets are 44 px tall; the panel keeps its room; Deshacer / Borrar and the
    // drawing pad stay above the tab bar.
    for (const [w, h, minPanel, padFits] of [[390, 844, 278, 1], [390, 664, 270, 1], [360, 640, 255, 1], [320, 568, 200, 0]]) {
      await page.setViewportSize({ width: w, height: h });
      await tab('cues');
      await sleep(250);
      const vp = `${w}x${h}`;
      await armOnScreen(page, vp);
      const [arm, qc, tap, fx, panel, tabs] = await Promise.all(['#arm', '#quick-colors', '#live-tap', '#fx-chip', '#page-cues', '.tabbar'].map((s) => box(page, s)));
      assert(Math.abs(arm.w - (w - 24)) < 1 && Math.abs(qc.w - arm.w) < 1 && Math.abs(qc.x - arm.x) < 1, `${vp}: arm and quick colours span the stage (${arm.w} px)`);
      assert(onScreen(tap) && onScreen(fx) && tap.h >= 44 && fx.h >= 44, `${vp}: TAP and the effect chip on screen, >= 44 px tall`);
      const sw = await page.evaluate(() => [...document.querySelectorAll('#quick-colors button')].map((b) => b.getBoundingClientRect()));
      const minW = Math.min(...sw.map((r) => r.width)), minH = Math.min(...sw.map((r) => r.height));
      assert(minH >= 44 && (w < 360 || minW >= 40), `${vp}: quick colours ${minW.toFixed(1)}x${minH.toFixed(1)} px (44 px tall${w < 360 ? '' : ', >= 40 px wide'})`);
      assert(panel.h >= minPanel && Math.abs(panel.b - tabs.y) < 1.5, `${vp}: the panel keeps ${Math.round(panel.h)} px (>= ${minPanel}) above the tab bar`);
      const scan = await page.evaluate(() => { const l = document.getElementById('scan-label'); return { text: l.textContent, whole: l.scrollWidth <= l.clientWidth,
        inside: l.getBoundingClientRect().right <= document.getElementById('preview-wrap').getBoundingClientRect().right }; });
      assert(scan.whole && scan.inside, `${vp}: scan label "${scan.text}" shown whole inside the preview`);
      if (w === 360) await page.screenshot({ path: path.join(OUT, 'redesign-phone-short.png') });
      await tab('shape');
      const seg = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#page-shape .seg button')].map((b) => b.getBoundingClientRect().height)));
      assert(seg >= 44, `${vp}: segmented buttons are ${seg} px tall (>= 44)`);
      await tab('draw');
      const [undo, clear, pad, tb] = await Promise.all(['#draw-undo', '#draw-clear', '#draw', '.tabbar'].map((s) => box(page, s)));
      assert(undo.b <= tb.y && clear.b <= tb.y && undo.h >= 44, `${vp}: Deshacer / Borrar fully above the tab bar`);
      if (padFits) assert(pad.b <= tb.y + 0.5, `${vp}: the drawing pad (${Math.round(pad.w)} px) fits above the tab bar`);
      if (w === 360) await page.screenshot({ path: path.join(OUT, 'redesign-phone-short-draw.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await tab('settings');

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
    // Small phone in landscape (667x375): TAP / effect under the preview so the preview can grow; the scan label fits.
    await page.setViewportSize({ width: 667, height: 375 });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'redesign-landscape-small.png') });
    await armOnScreen(page, '667x375');
    {
      const [pv, live, qc, label] = await Promise.all(['.preview-wrap', '#livebar', '#quick-colors', '#scan-label'].map((s) => box(page, s)));
      assert(pv.w >= 180 && onScreen(live) && onScreen(qc) && live.y >= pv.b, `667x375: preview ${pv.w} px (>= 180), TAP / effect under it`);
      const clipped = await page.evaluate(() => { const l = document.getElementById('scan-label'); return l.scrollWidth > l.clientWidth; });
      assert(label.r <= pv.r && !clipped, `667x375: scan label "${await page.locator('#scan-label').textContent()}" fits in the preview`);
    }

    // Connection lost right after beam safety blanked frames (the badge is still held up) and the server does not come
    // back: the badge and the last frame go (the UI no longer knows what is emitted); the banner never covers the arm.
    blanked = true;
    await page.waitForSelector('#blank-badge', { state: 'visible' });
    blanked = false;
    await sleep(150); // lit frames again; the badge stays up for its hold time
    assert(await page.locator('#blank-badge').isVisible() && await litPreview(page) > 500, 'before the drop: badge held up, laser light in the preview');
    refuse = true;
    sock.close();
    await page.waitForSelector('body.offline');
    await sleep(800);
    assert(await page.locator('#blank-badge').isHidden(), 'offline: the beam-safety badge is cleared');
    const litOff = await litPreview(page);
    assert(litOff < 20, `offline: the preview no longer shows the last frame (${litOff} lit pixels)`);
    for (const [w, h] of [[844, 390], [667, 375], [390, 844], [360, 640]]) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(250);
      const [banner, arm] = [await box(page, '#banner'), await box(page, '#arm')];
      assert(banner && onScreen(arm) && !overlap(banner, arm), `${w}x${h} offline: the banner does not cover the arm`);
      if (w === 844) await page.screenshot({ path: path.join(OUT, 'redesign-offline-landscape.png') });
    }
    refuse = false;
    blanked = false;
    await page.waitForFunction(() => !document.body.classList.contains('offline'), null, { timeout: 10000 });
    assert(true, 'reconnects once the server answers again');

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
    await aa(dp, '#page-shape .h-note', 'desktop: hint note "doble toque para centrar"');
    await aa(dp, '.cue.empty .name', 'desktop: empty cue label "Vacío"');
    await aa(dp, '.cue.empty .num', 'desktop: empty cue number');
    await dp.locator('.cue[data-index="2"]').click();
    await waitMsg((m) => m.type === 'cue' && m.index === 2, 'desktop: clicking a cue fires it');
    await dp.locator('[data-tab="fx"]').click();
    assert(await dp.locator('#page-fx').isVisible() && await dp.locator('#cue-grid').isVisible(), 'desktop: switching tabs keeps the cue grid visible');
    await dp.locator('[data-tab="shape"]').click();
    await sleep(300);
    await dp.screenshot({ path: path.join(OUT, 'redesign-desktop.png') });
    // Armed on desktop (mouse hold): the labels keep their contrast, also under the pointer (hover), and nothing animates
    // on the main thread.
    {
      const a = await dp.locator('#arm').boundingBox();
      await dp.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await dp.mouse.down(); await sleep(750); await dp.mouse.up();
      await dp.waitForSelector('body.armed');
      await aa(dp, '#arm-label', 'desktop armed, pointer over the arm (hover)');
      await dp.mouse.move(5, 300);
      await aa(dp, '#arm-label', 'desktop armed: arm label');
      await aa(dp, '#arm-state', 'desktop armed: status strip chip');
      await aa(dp, '.live-tag', 'desktop armed: preview tag');
      const anim = await mainThreadAnimations(dp);
      assert(anim.length === 0, `desktop armed: no running animation of a non-compositable property (${anim.join(', ') || 'none'})`);
      await dp.screenshot({ path: path.join(OUT, 'redesign-desktop-armed.png') });
    }
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
