// Coloured strokes -> galvo-friendly points, plus the output safety stages. Port of helios_web/rasterize.py
// (same defaults: lit step 450/pps, blank step 2x, dwell 4/2/3/3, beam dwell 8, >= max(200, pps*0.012) points).
import { stroke } from "./geometry.js";

const LIT_RATE = 450, BLANK_DWELL = 4, START_DWELL = 2, END_DWELL = 3, CORNER_DWELL = 3, BEAM_DWELL = 8;
const CORNER_ANGLE = Math.PI / 4, MIN_FRAME_SECONDS = 0.012, MIN_POINTS = 200, JOIN_EPS = 1e-4;
export const MAX_POINTS = 4095;
export const BEAM_SAFETY_EXTENT = 0.05;
export const TAIL_BLANK = 4; // blanked points closing every DAC frame

const clamp1 = (v) => Math.min(1, Math.max(-1, v));
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Apply scan size, swap and invert (in that order), then clamp to [-1, 1]. */
export function outputTransform(strokes, settings) {
  const k = settings.scanSize;
  return strokes.map((st) => stroke(st.points.map(([x0, y0, r, g, b]) => {
    let x = x0 * k, y = y0 * k;
    if (settings.swapXY) [x, y] = [y, x];
    if (settings.invertX) x = -x;
    if (settings.invertY) y = -y;
    return [clamp1(x), clamp1(y), r, g, b];
  }), st.closed));
}

function isCorner(prev, cur, next) {
  const ax = cur[0] - prev[0], ay = cur[1] - prev[1], bx = next[0] - cur[0], by = next[1] - cur[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < JOIN_EPS || lb < JOIN_EPS) return false;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) > CORNER_ANGLE;
}

function rasterizeOnce(strokes, litStep, blankStep) {
  const points = [];
  if (!strokes.length) return points;
  const lastStroke = strokes[strokes.length - 1];
  let pos = lastStroke.closed ? lastStroke.points[0] : lastStroke.points[lastStroke.points.length - 1];
  strokes.forEach((st, idx) => {
    const pts = st.points, start = pts[0];
    const jump = dist(pos, start) > JOIN_EPS;
    if (jump) {
      const n = Math.max(1, Math.ceil(dist(pos, start) / blankStep));
      for (let k = 1; k <= n; k++) points.push([pos[0] + ((start[0] - pos[0]) * k) / n, pos[1] + ((start[1] - pos[1]) * k) / n, 0, 0, 0]);
      for (let k = 0; k < BLANK_DWELL; k++) points.push([start[0], start[1], 0, 0, 0]);
    }
    if (pts.length === 1) {
      for (let k = 0; k < BEAM_DWELL; k++) points.push([...start]);
      pos = start;
      return;
    }
    if (jump) for (let k = 0; k < START_DWELL; k++) points.push([...start]);
    const chain = st.closed ? [...pts, pts[0]] : pts;
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i], b = chain[i + 1], color = a.slice(2, 5);
      const n = Math.max(1, Math.ceil(dist(a, b) / litStep));
      for (let k = 1; k <= n; k++) points.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, ...color]);
      const following = i + 2 < chain.length ? chain[i + 2] : st.closed ? chain[1] : null;
      if (following && isCorner(a, b, following)) for (let k = 0; k < CORNER_DWELL; k++) points.push([b[0], b[1], ...color]);
    }
    const end = chain[chain.length - 1], next = strokes[(idx + 1) % strokes.length].points[0];
    if (dist(end, next) > JOIN_EPS) {
      const last = points[points.length - 1];
      for (let k = 0; k < END_DWELL; k++) points.push([...last]);
    }
    pos = end;
  });
  return points;
}

export function rasterize(strokes, pps, maxPoints = MAX_POINTS) {
  const minPoints = Math.min(maxPoints, Math.max(MIN_POINTS, Math.floor(pps * MIN_FRAME_SECONDS)));
  let litStep = LIT_RATE / pps;
  let points = rasterizeOnce(strokes, litStep, 2 * litStep);
  for (let i = 0; i < 4 && points.length > maxPoints; i++) {
    litStep *= (1.15 * points.length) / maxPoints;
    points = rasterizeOnce(strokes, litStep, 2 * litStep);
  }
  points = points.slice(0, maxPoints);
  if (!points.length) return Array.from({ length: minPoints }, () => [0, 0, 0, 0, 0]);
  if (points.length < minPoints) {
    const reps = Math.ceil(minPoints / points.length), base = points;
    points = [];
    for (let r = 0; r < reps; r++) points.push(...base);
  }
  return points;
}

export const isLit = (p) => p[2] > 0 || p[3] > 0 || p[4] > 0;

/** false when every lit point sits inside a box smaller than BEAM_SAFETY_EXTENT in both directions */
export function beamSafe(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, any = false;
  for (const p of points) {
    if (!isLit(p)) continue;
    any = true;
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  return !any || maxX - minX >= BEAM_SAFETY_EXTENT || maxY - minY >= BEAM_SAFETY_EXTENT;
}

/** Full output stage -> { preview, points }. Preview: after output transform, colours before brightness. */
export function buildFrame(worldStrokes, settings, maxPoints = MAX_POINTS) {
  const strokes = outputTransform(worldStrokes, settings);
  let points = rasterize(strokes, settings.pps, maxPoints - TAIL_BLANK);
  // always end dark: a late next frame can never leave a stationary lit beam
  const last = points[points.length - 1];
  for (let k = 0; k < TAIL_BLANK; k++) points.push([last[0], last[1], 0, 0, 0]);
  if (settings.beamSafety && !beamSafe(points)) return { preview: [], points: points.map(([x, y]) => [x, y, 0, 0, 0]) };
  const b = settings.brightness;
  return { preview: strokes, points: points.map(([x, y, r, g, bl]) => [x, y, r * b, g * b, bl * b]) };
}
