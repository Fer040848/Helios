// Live mini previews of the filled cues, drawn in the browser from the pure engine (engine/model.js + effects.js),
// so they work the same with the Python server and with the in-browser WebUSB backend.
//
// Performance: in WebUSB mode the laser output loop shares this main thread, so the thumbnails must never hold it up.
// - one shared scheduler: a rAF tick per round, each thumbnail redrawn at ~8 fps at most;
// - the budget counts the real cost of a tick: the drawing calls plus the raster / upload of the changed canvases and
//   the rest of that frame's rendering, measured from the tick to the first task after the frame (a MessageChannel
//   message posted in the tick runs once the rendering update is done). The drawing calls alone are about a third
//   of it, so a tick renders only what is predicted to fit in ~6 ms of real time (at least one thumbnail), and the
//   scheduler then idles DUTY times the measured cost: the thumbnails take about 1/(DUTY+1) of the main thread at
//   most, round-robin, so a slow device gets slower thumbnails, not a saturated main thread or a slower output loop;
// - only tiles on screen are drawn (IntersectionObserver) and nothing runs while the page is hidden;
// - static frames (draw a changed thumbnail once, then stop) with prefers-reduced-motion and while the in-browser
//   backend is armed (state.transport === "webusb"), so nothing competes with the output;
// - no layout reads in the tick: canvas sizes come from a ResizeObserver.
import { mergeScene, SCENE_DEFAULTS } from "./engine/model.js";
import { Clocks, compose } from "./engine/effects.js";

const FRAME_MS = 125, // ~8 fps per thumbnail at most
  SLACK_MS = 20, // a thumbnail due within this is drawn now, so they stay grouped in one tick
  TICK_MS = 6, // per tick, in real main-thread time (drawing + raster / upload of the changed canvases)
  DUTY = 5, // after a tick, idle DUTY x its real cost (thumbnails: ~1/6 of the main thread at most)
  MAX_RATIO = 10, // a tick's real cost is charged at most this many times its drawing calls
  MAX_IDLE_MS = 250, // two thumbnail frames: the longest the thumbnails ever pause after a tick
  PROBE_EVERY = 8,
  MAX_DT = 0.25, // s; a paused thumbnail resumes without a visible jump
  MAX_DPR = 2,
  MAX_VERTICES = 600, // decimate denser figures: a thumbnail is under 200 device px wide
  LINE_CSS_PX = 1.25;

/** Counters for tests and tuning; never read by the scheduler itself. */
export const stats = { ticks: 0, renders: 0, busyMs: 0, maxMs: 0, realMs: 0 };

const tiles = []; // index -> tile
let bpm = 120,
  liveUsb = false,
  cursor = 0,
  raf = 0,
  timer = 0,
  ratio = 3, // real cost / drawing-call cost of a tick (running average; starts at about what was measured)
  baseline = 0, // cost of a frame without thumbnail work (running average of probe frames)
  idleUntil = 0, // performance.now() before which no tick starts
  measuring = false, // a tick's (or a probe frame's) cost is being measured: its message reschedules
  probe = false,
  tickStart = 0,
  tickJs = 0,
  sinceProbe = 0;
// Real cost of a tick: from the tick to the first task after its frame, when that frame's rendering (raster and
// upload of the changed canvases, commit) is done, minus what a frame costs without thumbnails (the other rAF
// work, the preview). Every PROBE_EVERY ticks an empty frame is measured to keep that baseline current.
const afterFrame = new MessageChannel();
function measure(start, js, isProbe) {
  measuring = true;
  probe = isProbe;
  tickStart = start;
  tickJs = js;
  afterFrame.port2.postMessage(0);
}
afterFrame.port1.onmessage = () => {
  const now = performance.now(),
    frame = now - tickStart;
  measuring = false;
  if (probe) baseline = 0.7 * baseline + 0.3 * frame;
  else {
    // A long frame of other work (a GC pause, a heavy layout, another rAF callback) is not the thumbnails' cost: the
    // sample is capped, and so is the idle, so stray work never freezes the thumbnails (or a changed cue's) for long.
    const real = Math.max(tickJs, Math.min(frame - baseline, MAX_RATIO * tickJs));
    ratio = Math.min(MAX_RATIO, Math.max(1, 0.8 * ratio + 0.2 * (real / Math.max(0.1, tickJs))));
    stats.realMs += real;
    idleUntil = now + Math.min(DUTY * real, MAX_IDLE_MS);
    if (++sinceProbe >= PROBE_EVERY) {
      sinceProbe = 0;
      measuring = true; // no tick until the probe frame is measured
      requestAnimationFrame(() => measure(performance.now(), 0, true));
      return;
    }
  }
  schedule();
};

const motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
let reduced = !!motionQuery?.matches;
motionQuery?.addEventListener?.("change", (e) => {
  reduced = e.matches;
  schedule();
});
document.addEventListener("visibilitychange", schedule);

const io =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const t = e.target.__thumb;
          if (t) t.visible = e.isIntersecting;
        }
        schedule();
      })
    : null;
const ro =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
        for (const e of entries) {
          const t = e.target.__thumb;
          if (!t) continue;
          const w = Math.round(e.contentRect.width * dpr),
            h = Math.round(e.contentRect.height * dpr);
          if (w !== t.w || h !== t.h) {
            Object.assign(t, { w, h, dpr, dirty: true });
          }
        }
        schedule();
      })
    : null;

const animating = () => !reduced && !liveUsb;

/** Create the thumbnail canvas of cue slot `index` inside `host`. */
export function attach(index, host) {
  const canvas = document.createElement("canvas");
  canvas.className = "thumb";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const t = {
    canvas,
    ctx: canvas.getContext("2d"),
    cue: null,
    sig: "",
    scene: null,
    clocks: new Clocks(),
    visible: !io,
    dirty: false,
    last: 0,
    next: 0,
    cost: 0,
    w: 0,
    h: 0,
    dpr: 1,
  };
  canvas.__thumb = t;
  tiles[index] = t;
  io?.observe(canvas);
  if (ro) ro.observe(canvas);
  else {
    // no ResizeObserver: size once from layout
    const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    Object.assign(t, {
      w: Math.round(canvas.clientWidth * dpr),
      h: Math.round(canvas.clientHeight * dpr),
      dpr,
    });
  }
}

/** Feed the latest backend state: cues, BPM, and whether the in-browser backend is driving the laser. */
export function update(state) {
  bpm = +state?.bpm || 120;
  liveUsb = !!state?.armed && state?.transport === "webusb";
  const cues = state?.cues || [];
  tiles.forEach((t, i) => {
    const cue = cues[i] || null;
    if (cue === t.cue) return; // the WebUSB backend replaces cues on change, never mutates them
    t.cue = cue;
    const sig = cue ? JSON.stringify(cue.scene ?? null) : "";
    if (sig === t.sig) return; // same scene in a new object (every WebSocket state) or only a rename
    t.sig = sig;
    t.scene = cue ? mergeScene(SCENE_DEFAULTS, cue.scene) : null;
    t.dirty = !!cue;
    if (!cue) t.last = 0;
  });
  schedule();
}

function due(t, now) {
  if (!t || !t.scene || !t.visible || !t.w || !t.h) return false;
  return t.dirty || (animating() && now + SLACK_MS >= t.next);
}

function schedule() {
  if (raf || measuring) return; // the pending tick / the cost measurement reschedules
  clearTimeout(timer);
  timer = 0;
  if (document.hidden) return;
  const now = performance.now();
  let wait = Infinity;
  for (const t of tiles) {
    if (!t || !t.scene || !t.visible || !t.w || !t.h) continue;
    if (t.dirty) {
      wait = 0;
      break;
    }
    if (animating()) wait = Math.min(wait, t.next - now);
  }
  if (wait === Infinity) return; // nothing to draw: the scheduler stops until something changes
  wait = Math.max(wait, idleUntil - now);
  if (wait <= 1) raf = requestAnimationFrame(tick);
  else
    timer = setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(tick);
    }, wait);
}

function tick() {
  raf = 0;
  if (document.hidden) return;
  const t0 = performance.now(),
    n = tiles.length;
  let done = 0;
  for (let k = 0; k < n; k++) {
    const i = (cursor + k) % n,
      t = tiles[i];
    if (!due(t, t0)) continue;
    const start = performance.now();
    if (done && (start - t0 + t.cost) * ratio > TICK_MS) {
      cursor = i; // out of budget: continue from this tile on the next tick
      break;
    }
    render(t, t0);
    const ms = performance.now() - start;
    t.cost = t.cost ? 0.8 * t.cost + 0.2 * ms : ms;
    done++;
  }
  const ms = performance.now() - t0;
  stats.ticks++;
  stats.renders += done;
  stats.busyMs += ms;
  stats.maxMs = Math.max(stats.maxMs, ms);
  if (done) measure(t0, ms, false);
  else schedule();
}

function render(t, now) {
  const anim = animating();
  t.dirty = false;
  t.next = now + FRAME_MS;
  let scene = t.scene;
  if (anim) {
    const dt = t.last ? Math.min(MAX_DT, (now - t.last) / 1000) : 0;
    t.clocks.advance(dt, scene, bpm);
    t.last = now;
  } else {
    t.last = 0; // resume without a jump when animation comes back
    // a static frame of "draw on" at its start would be empty: show the whole figure
    if (scene.effect === "drawOn") scene = { ...scene, effect: "none" };
  }
  let strokes = [];
  try {
    strokes = compose(scene, t.clocks);
  } catch {
    /* a bad cue draws black; the other thumbnails keep going */
  }
  draw(t, strokes);
}

const colorCache = new Map();
function css(r, g, b) {
  // 5 bits per channel: fewer strokeStyle changes along rainbow figures, invisible at this size
  const key =
    ((r * 31 + 0.5) | 0) * 1024 +
    ((g * 31 + 0.5) | 0) * 32 +
    ((b * 31 + 0.5) | 0);
  let c = colorCache.get(key);
  if (!c) {
    const q = (v) => Math.round(((v * 31 + 0.5) | 0) * (255 / 31));
    c = `rgb(${q(r)},${q(g)},${q(b)})`;
    colorCache.set(key, c);
  }
  return [key, c];
}

/** Thin additive lines on black; world [-1, 1] (+y up) fitted in the centred square. No output transform. */
function draw(t, strokes) {
  const { canvas, ctx, w: W, h: H } = t;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const half = (Math.min(W, H) / 2) * 0.94,
    cx = W / 2,
    cy = H / 2;
  const X = (x) => cx + x * half,
    Y = (y) => cy - y * half;
  const total = strokes.reduce((s, st) => s + st.points.length, 0);
  const step = Math.max(1, Math.ceil(total / MAX_VERTICES));
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, LINE_CSS_PX * t.dpr);
  for (const st of strokes) {
    let pts = st.points;
    if (step > 1 && pts.length > 2)
      pts = pts.filter((_, i) => i % step === 0 || i === st.points.length - 1);
    const n = pts.length;
    if (n === 1) {
      const [x, y, r, g, b] = pts[0];
      if (r + g + b <= 0) continue;
      ctx.strokeStyle = css(r, g, b)[1];
      ctx.beginPath();
      ctx.moveTo(X(x), Y(y));
      ctx.lineTo(X(x) + 0.1, Y(y));
      ctx.stroke();
      continue;
    }
    const segs = st.closed ? n : n - 1;
    let key = -1; // colour of the open path, batched while consecutive segments share it
    for (let i = 0; i < segs; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n];
      if (a[2] + a[3] + a[4] <= 0) {
        if (key >= 0) ctx.stroke();
        key = -1;
        continue;
      }
      const [k, c] = css(a[2], a[3], a[4]);
      if (k !== key) {
        if (key >= 0) ctx.stroke();
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(X(a[0]), Y(a[1]));
        key = k;
      }
      ctx.lineTo(X(b[0]), Y(b[1]));
    }
    if (key >= 0) ctx.stroke();
  }
}
