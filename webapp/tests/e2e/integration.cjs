// End-to-end test against the real Python backend (simulator mode) in a phone-sized browser.
// Usage: node tests/e2e/integration.cjs   (PYTHON=/path/to/python to pick the interpreter with aiohttp)
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEBAPP = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL - ' + msg);
  console.log('ok - ' + msg);
}

async function state() {
  return (await fetch(`${BASE}/api/state`)).json();
}

async function until(fn, msg, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('FAIL - timeout: ' + msg);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'helios-e2e-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const server = spawn(process.env.PYTHON || 'python3',
    ['-m', 'helios_web', '--simulate', '--port', String(PORT), '--data', data], { cwd: WEBAPP, env });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const browser = await chromium.launch();
  try {
    await until(async () => { try { return (await fetch(`${BASE}/api/state`)).ok; } catch { return false; } },
      'server start', 10000);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const center = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    const tab = async (name) => { await page.locator(`[data-tab="${name}"]`).tap(); await sleep(250); };

    await page.goto(BASE);
    await until(async () => (await page.locator('.cue').count()) === 16, 'cue grid rendered');
    assert((await page.locator('#dac').textContent()) === 'SIMULADOR', 'simulator badge from real server');
    await sleep(600);
    const lit = await page.evaluate(() => {
      const c = document.getElementById('preview');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
      return n;
    });
    assert(lit > 200, `preview draws the live frame (${lit} lit pixels)`);
    await page.screenshot({ path: path.join(OUT, 'int-cues.png') });

    await page.locator('.cue[data-index="1"]').tap();
    await until(async () => (await state()).activeCue === 1, 'cue 1 triggered');
    assert((await state()).scene.pattern === 'tunnel', 'cue 1 loads the tunnel scene');

    const [ax, ay] = await center('#arm');
    await touch('touchStart', ax, ay); await sleep(150); await touch('touchEnd');
    await sleep(300);
    assert((await state()).armed === false, 'short tap does not arm');
    await touch('touchStart', ax, ay); await sleep(750); await touch('touchEnd');
    await until(async () => (await state()).armed === true, 'hold arms the output');
    await until(async () => (await page.locator('#arm-label').textContent()).startsWith('EN VIVO'), 'armed label');
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, 'int-armed.png') });
    await touch('touchStart', ax, ay); await touch('touchEnd');
    await until(async () => (await state()).armed === false, 'tap blacks out');

    await tab('shape');
    await page.locator('#patterns button', { hasText: 'Estrella' }).tap();
    await until(async () => (await state()).scene.pattern === 'star', 'pattern picker sets star');
    await page.screenshot({ path: path.join(OUT, 'int-shape.png') });

    await tab('text');
    await page.locator('#text-input').fill('Hola México');
    await until(async () => { const s = await state(); return s.scene.pattern === 'text' && s.scene.text === 'Hola México'; }, 'text sent');
    await sleep(500);
    await page.screenshot({ path: path.join(OUT, 'int-text.png') });

    await tab('draw');
    await page.locator('#draw').scrollIntoViewIfNeeded();
    const db = await page.locator('#draw').boundingBox();
    await touch('touchStart', db.x + db.width * 0.2, db.y + db.height * 0.8);
    for (let i = 1; i <= 15; i++) { await touch('touchMove', db.x + db.width * (0.2 + i * 0.04), db.y + db.height * (0.8 - i * 0.04)); await sleep(16); }
    await touch('touchEnd');
    await until(async () => { const s = await state(); return s.scene.pattern === 'drawing' && s.scene.drawing.length === 1; }, 'drawing sent');
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, 'int-draw.png') });

    for (const name of ['color', 'fx', 'settings']) {
      await tab(name);
      await page.screenshot({ path: path.join(OUT, `int-${name}.png`) });
    }
    await page.setViewportSize({ width: 844, height: 390 });
    await tab('cues');
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'int-landscape.png') });
    assert(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log('INTEGRATION OK');
  } catch (e) {
    console.error(e.message);
    console.error('--- server log ---\n' + log);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill('SIGINT');
    await sleep(500);
    fs.rmSync(data, { recursive: true, force: true });
  }
})();
