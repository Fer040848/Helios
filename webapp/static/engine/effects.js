// Scene composition: pattern -> effect -> transform -> mirror -> colour -> clip. Port of helios_web/effects.py.
import { generate } from "./patterns.js";
import {
  clip,
  mirror,
  segments,
  stroke,
  strokeLength,
  subdivide,
  transform,
} from "./geometry.js";

const TAU = 2 * Math.PI;
export const BEAT_PALETTE = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0.4, 1],
  [1, 1, 0],
  [0, 1, 1],
  [1, 0, 1],
  [1, 0.45, 0],
  [1, 1, 1],
];

/** Running clocks integrated each frame, so speed changes never make the image jump. */
export class Clocks {
  constructor() {
    this.anim = this.effect = this.color = this.spin = this.beats = 0;
  }
  advance(dt, scene, bpm) {
    this.anim += dt * scene.speed;
    this.effect += dt * scene.effectSpeed;
    this.color += dt * scene.colorSpeed;
    this.spin = (((this.spin + dt * scene.spin) % 360) + 360) % 360;
    this.beats += (dt * bpm) / 60;
  }
  copy() {
    return Object.assign(new Clocks(), this);
  }
}

export const hexToRgb = (c) =>
  [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6),
    f = h * 6 - i;
  const p = v * (1 - s),
    q = v * (1 - s * f),
    t = v * (1 - s * (1 - f));
  return [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6];
}

function rgbToHue([r, g, b]) {
  const max = Math.max(r, g, b),
    d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h =
    max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return (((h / 6) % 1) + 1) % 1;
}

const frac = (v) => ((v % 1) + 1) % 1;

function drawOn(strokes, fraction) {
  let budget = strokes.reduce((s, st) => s + strokeLength(st), 0) * fraction;
  const out = [];
  for (const st of strokes) {
    if (budget <= 0) break;
    const length = strokeLength(st);
    if (length <= budget) {
      out.push(st);
      budget -= length;
      continue;
    }
    const pts = [st.points[0]];
    for (const [a, b] of segments(st)) {
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (seg >= budget) {
        const f = seg ? budget / seg : 0;
        pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        break;
      }
      pts.push(b);
      budget -= seg;
    }
    out.push(stroke(pts));
    break;
  }
  return out;
}

function colorize(strokes, scene, clocks) {
  const paint = (rgb) =>
    strokes.map((st) =>
      stroke(
        st.points.map((p) => [p[0], p[1], ...rgb]),
        st.closed,
      ),
    );
  if (scene.colorMode === "solid") return paint(hexToRgb(scene.color));
  if (scene.colorMode === "cycle")
    return paint(
      hsvToRgb(
        frac(rgbToHue(hexToRgb(scene.color)) + clocks.color * 0.25),
        1,
        1,
      ),
    );
  if (scene.colorMode === "beat")
    return paint(BEAT_PALETTE[Math.floor(clocks.beats) % BEAT_PALETTE.length]);
  // rainbow: hue runs once along the whole figure and drifts with the colour clock
  const sub = subdivide(strokes, 0.08);
  const total = sub.reduce((s, st) => s + strokeLength(st), 0) || 1;
  let travelled = 0;
  return sub.map((st) =>
    stroke(
      st.points.map((p, i) => {
        const out = [
          p[0],
          p[1],
          ...hsvToRgb(frac(travelled / total + clocks.color * 0.5), 1, 1),
        ];
        if (i + 1 < st.points.length || st.closed) {
          const n = st.points[(i + 1) % st.points.length];
          travelled += Math.hypot(n[0] - p[0], n[1] - p[1]);
        }
        return out;
      }),
      st.closed,
    ),
  );
}

/** Render a scene at the given clocks into coloured world-space strokes clipped to [-1, 1]. */
export function compose(scene, clocks) {
  const size = scene.size;
  let strokes = generate(scene, clocks.anim, size);
  const { effect, effectAmount: amount } = scene;
  const phase = frac(scene.beatSync ? clocks.beats : clocks.effect);
  let scale = size,
    angle = scene.rotation + clocks.spin,
    dx = scene.x,
    dy = scene.y;

  if (effect === "pulse") scale *= 1 + 0.5 * amount * Math.exp(-5 * phase);
  else if (effect === "zoom")
    scale *= 1 - 0.8 * amount * (0.5 - 0.5 * Math.cos(TAU * phase));
  else if (effect === "orbit") {
    dx += 0.5 * amount * Math.cos(TAU * phase);
    dy += 0.5 * amount * Math.sin(TAU * phase);
  } else if (effect === "bounce")
    dy += 0.6 * amount * (Math.abs(Math.sin(Math.PI * phase)) - 0.5);
  else if (effect === "wobble") angle += 45 * amount * Math.sin(TAU * phase);
  else if (effect === "strobe" && phase >= 1 - 0.85 * amount) return [];

  strokes = transform(strokes, scale, angle, dx, dy);
  if (effect === "wave") {
    strokes = subdivide(strokes, 0.04).map((st) =>
      stroke(
        st.points.map(([x, y]) => [
          x,
          y + 0.25 * amount * Math.sin(TAU * (1.5 * x + phase)),
        ]),
        st.closed,
      ),
    );
  } else if (effect === "drawOn") {
    strokes = drawOn(strokes, Math.min(1, phase * (1 + 2 * amount)));
  }
  return clip(colorize(mirror(strokes, scene.mirror), scene, clocks));
}
