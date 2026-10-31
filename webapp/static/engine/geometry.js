// Stroke helpers. Port of helios_web/geometry.py (keep in sync).
// A stroke is { points: [[x, y], ...], closed }; a coloured stroke has [x, y, r, g, b] points, where the colour is
// that of the segment starting at the point.

export const stroke = (points, closed = false) => ({ points, closed });

export function polygon(sides, radius = 1, phaseDeg = 90) {
  const phase = (phaseDeg * Math.PI) / 180;
  return Array.from({ length: sides }, (_, k) => {
    const a = phase + (2 * Math.PI * k) / sides;
    return [radius * Math.cos(a), radius * Math.sin(a)];
  });
}

/** Scale, then rotate (counter-clockwise), then translate. */
export function transform(strokes, scale = 1, angleDeg = 0, dx = 0, dy = 0) {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  return strokes.map((st) => stroke(st.points.map(([x, y]) => [x * c - y * s + dx, x * s + y * c + dy]), st.closed));
}

export function segments(st) {
  const pts = st.points, pairs = [];
  for (let i = 0; i + 1 < pts.length; i++) pairs.push([pts[i], pts[i + 1]]);
  if (st.closed && pts.length > 2) pairs.push([pts[pts.length - 1], pts[0]]);
  return pairs;
}

export function subdivide(strokes, maxLen) {
  return strokes.map((st) => {
    if (st.points.length < 2) return st;
    const pts = [];
    for (const [[x0, y0], [x1, y1]] of segments(st)) {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxLen));
      for (let k = 0; k < n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
    if (!st.closed) pts.push(st.points[st.points.length - 1]);
    return stroke(pts, st.closed);
  });
}

/** Add mirrored copies about the centre: h (left/right), v (up/down) or quad (both). */
export function mirror(strokes, mode) {
  if (mode === "none") return strokes;
  const flips = { h: [[-1, 1]], v: [[1, -1]], quad: [[-1, 1], [1, -1], [-1, -1]] }[mode];
  const out = [...strokes];
  for (const [fx, fy] of flips) for (const st of strokes) out.push(stroke(st.points.map(([x, y]) => [x * fx, y * fy]), st.closed));
  return out;
}

function clipSegment(x0, y0, x1, y1, lim) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 + lim], [dx, lim - x0], [-dy, y0 + lim], [dy, lim - y0]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        t0 = Math.max(t0, t);
      } else {
        if (t < t0) return null;
        t1 = Math.min(t1, t);
      }
    }
  }
  return [t0, t1];
}

/** Clip coloured strokes to the square [-lim, lim]^2, splitting them where they leave it. */
export function clip(strokes, lim = 1) {
  const out = [];
  for (const st of strokes) {
    const pts = st.points;
    if (pts.every((p) => Math.abs(p[0]) <= lim && Math.abs(p[1]) <= lim)) {
      out.push(st);
      continue;
    }
    if (pts.length === 1) continue;
    const chain = st.closed ? [...pts, pts[0]] : pts;
    let current = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i], b = chain[i + 1];
      const hit = clipSegment(a[0], a[1], b[0], b[1], lim);
      if (!hit) {
        if (current.length) out.push(stroke(current));
        current = [];
        continue;
      }
      const [t0, t1] = hit;
      const start = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, ...a.slice(2)];
      // an unclipped end keeps b's own colour, which colours the next segment
      const end = t1 >= 1 ? [...b] : [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, ...a.slice(2)];
      if (t0 > 0 && current.length) {
        out.push(stroke(current));
        current = [];
      }
      if (!current.length) current = [start];
      current.push(end);
      if (t1 < 1) {
        out.push(stroke(current));
        current = [];
      }
    }
    if (current.length > 1) out.push(stroke(current));
  }
  return out;
}

export const strokeLength = (st) => segments(st).reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
