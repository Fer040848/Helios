// Helpers for ui_mock.cjs: a static file server for webapp/static and contract-shaped mock messages.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function startStaticServer(root) {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const rel = p === '/' ? 'index.html' : p.startsWith('/static/') ? p.slice(8) : null;
    const file = rel && path.resolve(root, rel);
    if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => { srv.closeAllConnections(); srv.close(); } })));
}

const PATTERNS = [['circle', 'Círculo'], ['square', 'Cuadrado'], ['triangle', 'Triángulo'], ['star', 'Estrella'], ['heart', 'Corazón'], ['line', 'Línea'],
  ['spiral', 'Espiral'], ['wave', 'Onda'], ['lissajous', 'Lissajous'], ['tunnel', 'Túnel'], ['fan', 'Abanico'], ['grid', 'Rejilla'], ['flower', 'Flor'],
  ['text', 'Texto'], ['drawing', 'Dibujo']];
const EFFECTS = [['none', 'Ninguno'], ['pulse', 'Pulso'], ['wave', 'Ondulación'], ['orbit', 'Órbita'], ['bounce', 'Rebote'], ['zoom', 'Zoom'],
  ['strobe', 'Estrobo'], ['wobble', 'Vaivén'], ['drawOn', 'Trazado']];
const MODES = [['solid', 'Sólido'], ['rainbow', 'Arcoíris'], ['cycle', 'Ciclo'], ['beat', 'Al ritmo']];
const list = (a) => a.map(([id, name]) => ({ id, name }));

function makeState() {
  const scene = { pattern: 'circle', text: 'HOLA', textMode: 'static', drawing: [], size: 0.6, x: 0, y: 0, rotation: 0, spin: 0, speed: 1, color: '#00ff00',
    colorMode: 'solid', colorSpeed: 0.5, effect: 'none', effectAmount: 0.5, effectSpeed: 0.5, beatSync: false, mirror: 'none' };
  const cue = (name, s) => ({ name, scene: { ...scene, ...s } });
  const cues = Array(16).fill(null);
  cues[0] = cue('Círculo', {});
  cues[1] = cue('Túnel arcoíris', { pattern: 'tunnel', colorMode: 'rainbow' });
  cues[2] = cue('Estrella', { pattern: 'star', color: '#ffff00', spin: 90 });
  cues[3] = cue('Corazón', { pattern: 'heart', color: '#ff0000' });
  cues[4] = cue('HOLA', { pattern: 'text', color: '#00ffff' });
  cues[5] = cue('Abanico', { pattern: 'fan', color: '#ff00ff' });
  return {
    armed: false, simulated: true, dacs: [{ index: 0, name: 'Simulador', kind: 'sim' }], scene,
    settings: { pps: 30000, brightness: 0.3, scanSize: 0.8, invertX: false, invertY: false, swapXY: false, beamSafety: true },
    cues, activeCue: null, bpm: 120.0, patterns: list(PATTERNS), effects: list(EFFECTS), colorModes: list(MODES),
  };
}

// A circle with a hue sweep, as the server would stream it.
function circleFrame(t) {
  const s = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2, h = ((i / 120) + t * 0.01) % 1;
    const rgb = [0, 1, 2].map((k) => Math.round(255 * Math.max(0, Math.min(1, Math.abs(((h * 6 + [0, 4, 2][k]) % 6) - 3) - 1))));
    s.push(+(0.6 * Math.cos(a)).toFixed(3), +(0.6 * Math.sin(a)).toFixed(3), ...rgb);
  }
  return { type: 'frame', strokes: [s], fps: 60.2, points: 1200 };
}

module.exports = { startStaticServer, makeState, circleFrame };
