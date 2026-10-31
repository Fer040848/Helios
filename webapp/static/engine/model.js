// Scene / settings schema: defaults, validation, default cues. Port of helios_web/model.py (keep in sync).

export const PATTERNS = {
  circle: "Círculo",
  square: "Cuadrado",
  triangle: "Triángulo",
  star: "Estrella",
  heart: "Corazón",
  line: "Línea",
  spiral: "Espiral",
  wave: "Onda",
  lissajous: "Lissajous",
  tunnel: "Túnel",
  fan: "Abanico",
  grid: "Rejilla",
  flower: "Flor",
  text: "Texto",
  drawing: "Dibujo",
};
export const EFFECTS = {
  none: "Ninguno",
  pulse: "Pulso",
  wave: "Ondulación",
  orbit: "Órbita",
  bounce: "Rebote",
  zoom: "Zoom",
  strobe: "Estrobo",
  wobble: "Vaivén",
  drawOn: "Trazado",
};
export const COLOR_MODES = {
  solid: "Sólido",
  rainbow: "Arcoíris",
  cycle: "Ciclo",
  beat: "Al ritmo",
};
const MIRRORS = ["none", "h", "v", "quad"];
const TEXT_MODES = ["static", "scroll"];

export const MAX_TEXT = 64;
export const MAX_CUE_NAME = 24;
export const MAX_DRAWING_POINTS = 2000;
export const CUE_SLOTS = 16;
export const BPM_RANGE = [40, 240];

export const SCENE_DEFAULTS = {
  pattern: "circle",
  text: "HOLA",
  textMode: "static",
  drawing: [],
  size: 0.6,
  x: 0,
  y: 0,
  rotation: 0,
  spin: 0,
  speed: 1,
  color: "#00ff00",
  colorMode: "solid",
  colorSpeed: 0.5,
  effect: "none",
  effectAmount: 0.5,
  effectSpeed: 0.5,
  beatSync: false,
  mirror: "none",
};
export const SETTINGS_DEFAULTS = {
  pps: 30000,
  brightness: 0.3,
  scanSize: 0.8,
  invertX: false,
  invertY: false,
  swapXY: false,
  beamSafety: true,
};

const SCENE_NUMBERS = {
  size: [0, 1],
  x: [-1, 1],
  y: [-1, 1],
  rotation: [-180, 180],
  spin: [-360, 360],
  speed: [0, 2],
  colorSpeed: [0, 2],
  effectAmount: [0, 1],
  effectSpeed: [0, 2],
};
const SCENE_ENUMS = {
  pattern: Object.keys(PATTERNS),
  textMode: TEXT_MODES,
  colorMode: Object.keys(COLOR_MODES),
  effect: Object.keys(EFFECTS),
  mirror: MIRRORS,
};
const SETTINGS_NUMBERS = {
  pps: [1000, 65535],
  brightness: [0, 1],
  scanSize: [0.1, 1],
};
const SETTINGS_BOOLS = ["invertX", "invertY", "swapXY", "beamSafety"];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));

/** value clamped to [lo, hi], or null when it is not a finite number */
export function clampNumber(value, lo, hi) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(hi, Math.max(lo, value));
}

function cleanDrawing(value) {
  if (!Array.isArray(value)) return null;
  const strokes = [];
  let budget = MAX_DRAWING_POINTS;
  for (const stroke of value) {
    if (!Array.isArray(stroke) || budget <= 0) continue;
    const points = [];
    for (const p of stroke.slice(0, budget)) {
      if (Array.isArray(p) && p.length >= 2) {
        const x = clampNumber(p[0], -1, 1),
          y = clampNumber(p[1], -1, 1);
        if (x !== null && y !== null)
          points.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
      }
    }
    if (points.length) {
      strokes.push(points);
      budget -= points.length;
    }
  }
  return strokes;
}

/** new complete scene: base with the valid fields of partial applied */
export function mergeScene(base, partial) {
  const scene = clone(base);
  if (!partial || typeof partial !== "object" || Array.isArray(partial))
    return scene;
  for (const [key, value] of Object.entries(partial)) {
    if (key in SCENE_NUMBERS) {
      const n = clampNumber(value, ...SCENE_NUMBERS[key]);
      if (n !== null) scene[key] = n;
    } else if (key in SCENE_ENUMS) {
      if (typeof value === "string" && SCENE_ENUMS[key].includes(value))
        scene[key] = value;
    } else if (key === "text") {
      if (typeof value === "string")
        scene.text = [...value].slice(0, MAX_TEXT).join("");
    } else if (key === "color") {
      if (typeof value === "string" && COLOR_RE.test(value))
        scene.color = value.toLowerCase();
    } else if (key === "beatSync") {
      if (typeof value === "boolean") scene.beatSync = value;
    } else if (key === "drawing") {
      const d = cleanDrawing(value);
      if (d !== null) scene.drawing = d;
    }
  }
  return scene;
}

export function mergeSettings(base, partial) {
  const settings = { ...base };
  if (!partial || typeof partial !== "object" || Array.isArray(partial))
    return settings;
  for (const [key, value] of Object.entries(partial)) {
    if (key in SETTINGS_NUMBERS) {
      const n = clampNumber(value, ...SETTINGS_NUMBERS[key]);
      if (n !== null) settings[key] = key === "pps" ? Math.round(n) : n;
    } else if (SETTINGS_BOOLS.includes(key) && typeof value === "boolean") {
      settings[key] = value;
    }
  }
  return settings;
}

export function cleanCues(cues) {
  const list = Array.isArray(cues) ? cues.slice(0, CUE_SLOTS) : [];
  const out = list.map((c) =>
    c && typeof c === "object" && typeof c.name === "string"
      ? {
          name: [...c.name].slice(0, MAX_CUE_NAME).join(""),
          scene: mergeScene(SCENE_DEFAULTS, c.scene),
        }
      : null,
  );
  while (out.length < CUE_SLOTS) out.push(null);
  return out;
}

const DEFAULT_CUES = [
  ["Círculo verde", { pattern: "circle", color: "#00ff00" }],
  ["Túnel arcoíris", { pattern: "tunnel", colorMode: "rainbow" }],
  ["Estrella giratoria", { pattern: "star", color: "#ffff00", spin: 90 }],
  ["Onda azul", { pattern: "wave", color: "#0088ff" }],
  [
    "Texto HOLA",
    { pattern: "text", text: "HOLA", textMode: "scroll", color: "#ff00ff" },
  ],
  ["Abanico", { pattern: "fan", color: "#00ffff" }],
  ["Lissajous", { pattern: "lissajous", colorMode: "cycle" }],
  [
    "Corazón",
    { pattern: "heart", color: "#ff0000", effect: "pulse", beatSync: true },
  ],
  ["Rejilla", { pattern: "grid", color: "#00ff00", effect: "wave" }],
  ["Espiral", { pattern: "spiral", colorMode: "rainbow", spin: 60 }],
];

export const defaultCues = () =>
  cleanCues(DEFAULT_CUES.map(([name, scene]) => ({ name, scene })));
export const defaultScene = () => clone(SCENE_DEFAULTS);

export function catalog() {
  const entries = (names) =>
    Object.entries(names).map(([id, name]) => ({ id, name }));
  return {
    patterns: entries(PATTERNS),
    effects: entries(EFFECTS),
    colorModes: entries(COLOR_MODES),
  };
}
