// Transport selection (net.js): a flaky /static/runtime.json probe on the Python server must retry and end on the
// WebSocket, never silently on the in-browser simulator; old browsers without AbortSignal.timeout and browsers that
// block site storage must still start. Usage: node tests/e2e/transport.cjs
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const { startStaticServer, makeState } = require('./mock_backend.cjs');

const STATIC = path.resolve(__dirname, '..', '..', 'static');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error('FAIL - ' + msg);
  console.log('ok - ' + msg);
}
// the cue grid renders placeholders before any state; the pattern list only exists once a state arrived
const cuesShown = (page) => page.waitForFunction(() => document.querySelectorAll('#patterns button').length === 15, null, { timeout: 15000 });

(async () => {
  const browser = await chromium.launch();
  const servers = [];
  try {
    // 1. Python-server page whose first two runtime.json probes fail.
    const flaky = await startStaticServer(STATIC, { api: true, failRuntime: 2 });
    servers.push(flaky);
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    let wsConnections = 0;
    await page.routeWebSocket('**/ws', (ws) => {
      wsConnections++;
      ws.send(JSON.stringify({ type: 'state', state: makeState() }));
    });
    await page.goto(flaky.url);
    await cuesShown(page);
    assert(flaky.stats.runtimeRequests >= 3, `probe retried after failures (${flaky.stats.runtimeRequests} requests)`);
    assert(wsConnections >= 1, 'ended on the WebSocket to the server');
    await page.locator('[data-tab="settings"]').click();
    await sleep(200);
    assert((await page.locator('#rescan span').textContent()) === 'Buscar DAC', 'server-mode UI, not the in-browser engine');

    // 2. Old browser without AbortSignal.timeout (iOS 15) on the Python server.
    const server = await startStaticServer(STATIC, { api: true });
    servers.push(server);
    const old = await (await browser.newContext()).newPage();
    await old.addInitScript(() => { delete AbortSignal.timeout; });
    await old.routeWebSocket('**/ws', (ws) => ws.send(JSON.stringify({ type: 'state', state: makeState() })));
    const oldErrors = [];
    old.on('pageerror', (e) => oldErrors.push(String(e)));
    await old.goto(server.url);
    await cuesShown(old);
    assert(oldErrors.length === 0, 'starts without AbortSignal.timeout' + (oldErrors.length ? ': ' + oldErrors.join(' | ') : ''));

    // 3. Static site with site storage blocked.
    const statik = await startStaticServer(STATIC, { api: false });
    servers.push(statik);
    const blocked = await (await browser.newContext()).newPage();
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
    await blocked.goto(statik.url);
    await cuesShown(blocked);
    assert((await blocked.locator('#dac').textContent()) === 'SIMULADOR', 'in-browser engine starts with storage blocked');
    // 4. Static site on a slow link: every runtime.json answer takes 3 s (longer than the first probe timeout).
    const slow = await (await browser.newContext()).newPage();
    let slowProbes = 0;
    await slow.route('**/static/runtime.json', async (route) => { slowProbes++; await sleep(3000); await route.continue(); });
    await slow.goto(statik.url);
    await slow.waitForFunction(() => document.querySelectorAll('#patterns button').length === 15, null, { timeout: 30000 });
    assert(slowProbes >= 2 && (await slow.locator('#dac').textContent()) === 'SIMULADOR', `slow link still starts (probe timeout grows; ${slowProbes} probes)`);

    // 5. Static site where the first load of the engine module fails (flaky mobile data).
    const flakyEngine = await (await browser.newContext()).newPage();
    let engineLoads = 0;
    await flakyEngine.route('**/static/engine/local.js', (route) => (engineLoads++ === 0 ? route.abort('failed') : route.continue()));
    await flakyEngine.goto(statik.url);
    await flakyEngine.waitForFunction(() => document.querySelectorAll('#patterns button').length === 15, null, { timeout: 20000 });
    assert(engineLoads >= 2, `a failed engine load reloads the page once and recovers (${engineLoads} loads)`);
    assert(!flakyEngine.url().includes('recarga'), 'the reload marker is removed from the URL afterwards');
    console.log('TRANSPORT OK');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    servers.forEach((s) => s.close());
  }
})();
