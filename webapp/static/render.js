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

// Static layer under the preview strokes, drawn once into an off-screen canvas and reused for every frame (the
// caller rebuilds it only when the canvas size or the scan size changes): a faint 8x8 grid, the centre crosshair,
// the full-range border (the DAC's [-1, 1] limits) and the dashed scan area (settings.scanSize, symmetric, so swap
// and invert do not move it). Colours stay dim (r+g+b well below 300 per pixel) so only laser light reads as lit.
export function drawGuides(layer, W, H, scanSize) {
  const c = layer || document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const lw = Math.max(1, Math.round(W / 360)),
    half = lw / 2;
  // crisp lines: snap to whole device pixels, centred for the line width
  const at = (v, size) =>
    Math.min(size - half, Math.max(half, Math.round(v - half) + half));
  const line = (x0, y0, x1, y1) => {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  };
  ctx.lineWidth = lw;
  ctx.strokeStyle = "rgba(139, 147, 161, 0.1)"; // grid
  ctx.beginPath();
  for (let i = 1; i < 8; i++) {
    const x = at((i * W) / 8, W),
      y = at((i * H) / 8, H);
    line(x, 0, x, H);
    line(0, y, W, y);
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(139, 147, 161, 0.4)"; // centre crosshair
  const cx = at(W / 2, W),
    cy = at(H / 2, H),
    arm = Math.round(Math.min(W, H) * 0.035);
  ctx.beginPath();
  line(cx - arm, cy, cx + arm, cy);
  line(cx, cy - arm, cx, cy + arm);
  ctx.stroke();
  ctx.strokeStyle = "rgba(139, 147, 161, 0.32)"; // full range
  ctx.strokeRect(half, half, W - lw, H - lw);
  const s = Math.min(1, Math.max(0, +scanSize || 0));
  if (s > 0 && s < 1) {
    const x0 = at(((1 - s) / 2) * W, W),
      x1 = at(((1 + s) / 2) * W, W),
      y0 = at(((1 - s) / 2) * H, H),
      y1 = at(((1 + s) / 2) * H, H);
    ctx.strokeStyle = "rgba(230, 232, 235, 0.34)"; // scan area
    ctx.setLineDash([5 * lw, 4 * lw]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }
  return c;
}

/** Paint strokes over black, the drawing pad's plain grid (guides === true) or a drawGuides() layer. */
export function drawStrokes(ctx, strokes, guides = false) {
  const { width: W, height: H } = ctx.canvas;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  if (guides && guides !== true && guides.width === W && guides.height === H)
    ctx.drawImage(guides, 0, 0);
  else {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
  }
  if (guides === true) {
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
