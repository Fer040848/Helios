// Glowing laser-line renderer for flat coloured strokes [x, y, r, g, b, ...] in [-1, 1], +y up.
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)),
    h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

// A wide soft halo, a medium glow and a thin whitened core, blended additively.
const PASSES = [
  { w: 10, a: 0.1, white: 0 },
  { w: 4.5, a: 0.3, white: 0 },
  { w: 1.6, a: 1, white: 0.55 },
];

export function drawStrokes(ctx, strokes, guides = false) {
  const { width: W, height: H } = ctx.canvas;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (guides) {
    ctx.strokeStyle = "#141a28";
    ctx.lineWidth = Math.max(1, W / 400);
    ctx.beginPath();
    for (let i = 1; i < 8; i++) {
      const p = (i * W) / 8,
        q = (i * H) / 8;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, H);
      ctx.moveTo(0, q);
      ctx.lineTo(W, q);
    }
    ctx.stroke();
  }
  const X = (x) => ((x + 1) / 2) * W,
    Y = (y) => ((1 - y) / 2) * H,
    k = W / 400;
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of PASSES) {
    ctx.lineWidth = Math.max(1, p.w * k);
    ctx.globalAlpha = p.a;
    const col = (r, g, b) =>
      `rgb(${(r + (255 - r) * p.white) | 0},${(g + (255 - g) * p.white) | 0},${(b + (255 - b) * p.white) | 0})`;
    for (const s of strokes) {
      const n = (s.length / 5) | 0;
      if (n === 1 && s[2] + s[3] + s[4] > 0) {
        // single lit vertex: a dot
        ctx.strokeStyle = col(s[2], s[3], s[4]);
        ctx.beginPath();
        ctx.moveTo(X(s[0]), Y(s[1]));
        ctx.lineTo(X(s[0]) + 0.1, Y(s[1]));
        ctx.stroke();
        continue;
      }
      let key = -1; // colour of the open path, batched while consecutive segments share it
      for (let i = 1; i < n; i++) {
        const o = (i - 1) * 5,
          r = s[o + 2],
          g = s[o + 3],
          b = s[o + 4];
        if (r + g + b === 0) {
          if (key >= 0) ctx.stroke();
          key = -1;
          continue;
        } // blanked segment
        const c = (r << 16) | (g << 8) | b;
        if (c !== key) {
          if (key >= 0) ctx.stroke();
          ctx.strokeStyle = col(r, g, b);
          ctx.beginPath();
          ctx.moveTo(X(s[o]), Y(s[o + 1]));
          key = c;
        }
        ctx.lineTo(X(s[o + 5]), Y(s[o + 6]));
      }
      if (key >= 0) ctx.stroke();
    }
  }
}
