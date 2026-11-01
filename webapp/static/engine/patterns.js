// Pattern generators in pattern space ([-1, 1], before size/position). Port of helios_web/patterns.py.
import * as font from "./font.js";
import { polygon, stroke } from "./geometry.js";

const TAU = 2 * Math.PI;
const circlePoints = (r, n = 72) =>
  Array.from({ length: n }, (_, k) => [
    r * Math.cos((TAU * k) / n),
    r * Math.sin((TAU * k) / n),
  ]);
const range = (n) => Array.from({ length: n }, (_, k) => k);

const TEXT_HEIGHT_STATIC = 1.0,
  TEXT_HEIGHT_SCROLL = 0.8,
  SCROLL_SPEED = 0.6;
const mod = (a, b) => ((a % b) + b) % b;

export const GENERATORS = {
  circle: () => [stroke(circlePoints(1), true)],
  square: () => [stroke(polygon(4, 1, 45), true)],
  triangle: () => [stroke(polygon(3, 1, 90), true)],
  star: () => [
    stroke(
      range(10).map((k) => {
        const r = k % 2 === 0 ? 1 : 0.4,
          a = Math.PI / 2 + (Math.PI * k) / 5;
        return [r * Math.cos(a), r * Math.sin(a)];
      }),
      true,
    ),
  ],
  heart: () => [
    stroke(
      range(80).map((k) => {
        const u = (TAU * k) / 80;
        const x = 16 * Math.sin(u) ** 3;
        const y =
          13 * Math.cos(u) -
          5 * Math.cos(2 * u) -
          2 * Math.cos(3 * u) -
          Math.cos(4 * u);
        return [x / 17, (y + 2.5) / 17];
      }),
      true,
    ),
  ],
  line: () => [
    stroke([
      [-1, 0],
      [1, 0],
    ]),
  ],
  spiral: (scene, t) => [
    stroke(
      range(161).map((k) => {
        const f = k / 160,
          r = 0.05 + 0.95 * f,
          a = t * 2 + TAU * 4 * f;
        return [r * Math.cos(a), r * Math.sin(a)];
      }),
    ),
  ],
  wave: (scene, t) => [
    stroke(
      range(91).map((k) => {
        const x = -1 + (2 * k) / 90;
        return [x, 0.5 * Math.sin(3 * Math.PI * x + t * 3)];
      }),
    ),
  ],
  lissajous: (scene, t) => [
    stroke(
      range(180).map((k) => {
        const u = (TAU * k) / 180;
        return [Math.sin(3 * u + t * 0.7), Math.sin(2 * u)];
      }),
      true,
    ),
  ],
  tunnel: (scene, t) =>
    range(4)
      .map((k) => mod(k / 4 + t * 0.3, 1))
      .filter((r) => r > 0.06)
      .map((r) => stroke(circlePoints(r, 48), true)),
  fan: (scene, t) => {
    const spread = 0.65 + 0.35 * Math.sin(t * 1.5);
    return range(7).map((k) => stroke([[(-1 + (2 * k) / 6) * spread, 0]]));
  },
  grid: () => {
    const out = [];
    for (const k of range(5)) {
      const v = -1 + (2 * k) / 4;
      out.push(
        stroke(
          k % 2 === 0
            ? [
                [-1, v],
                [1, v],
              ]
            : [
                [1, v],
                [-1, v],
              ],
        ),
      );
    }
    for (const k of range(5)) {
      const v = 1 - (2 * k) / 4;
      out.push(
        stroke(
          k % 2 === 0
            ? [
                [v, 1],
                [v, -1],
              ]
            : [
                [v, -1],
                [v, 1],
              ],
        ),
      );
    }
    return out;
  },
  flower: (scene, t) => [
    stroke(
      range(200).map((k) => {
        const u = (Math.PI * k) / 200,
          r = Math.cos(5 * u);
        return [r * Math.cos(u + t * 0.3), r * Math.sin(u + t * 0.3)];
      }),
      true,
    ),
  ],
  text: (scene, t, size) => {
    const { polylines, width } = font.layout(scene.text || "");
    if (!polylines.length) return [];
    let s, x0;
    if (scene.textMode === "scroll") {
      s = TEXT_HEIGHT_SCROLL / font.CAP_HEIGHT;
      const window = 1 / Math.max(size, 0.05);
      const travel = 2 * window + width * s;
      x0 = window - mod((t * SCROLL_SPEED) / Math.max(size, 0.05), travel);
    } else {
      s = Math.min(
        width ? 1.9 / width : 1,
        TEXT_HEIGHT_STATIC / font.CAP_HEIGHT,
      );
      x0 = (-width * s) / 2;
    }
    const y0 = (-font.CAP_HEIGHT * s) / 2;
    return polylines.map((pl) =>
      stroke(pl.map(([x, y]) => [x0 + x * s, y0 + y * s])),
    );
  },
  // drawn 1:1 with the phone canvas: undo the engine's size scaling
  drawing: (scene, t, size) => {
    if (size < 0.01) return [];
    const k = 1 / size;
    return (scene.drawing || [])
      .filter((st) => st.length)
      .map((st) => stroke(st.map(([x, y]) => [x * k, y * k])));
  },
};

export const generate = (scene, t, size) =>
  GENERATORS[scene.pattern](scene, t, size);
