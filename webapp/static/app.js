// Helios Web Control - frontend. Vanilla ES module, no dependencies.
import { connect } from "./net.js";
import { fitCanvas, drawStrokes, drawGuides } from "./render.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const HOLD_MS = 600,
  SEND_MS = 50,
  GRACE_MS = 400,
  CUES = 16,
  MAX_DRAW_PTS = 2000;

let S = null; // last server state (single source of truth)
let online = false; // socket open and a state received on it
let thumbs = null; // thumbs.js once loaded (live cue thumbnails)
const busy = new Map(); // control key -> time until incoming state must not overwrite it (Infinity while touched)
const isBusy = (k) => (busy.get(k) ?? 0) > performance.now();
const hold = (k) => busy.set(k, Infinity);
const release = (k) => busy.set(k, performance.now() + GRACE_MS);
const touch = (k) => {
  if (busy.get(k) !== Infinity) release(k);
};

const conn = connect({ onMessage, onStatus });
const send = (msg) => online && conn.send(msg);
function sendValue(key, value) {
  const [sec, field] = key.split(".");
  if (key === "bpm") send({ type: "bpm", bpm: value });
  else send({ type: sec, [sec]: { [field]: value } });
}
function getValue(key) {
  const [a, b] = key.split(".");
  return b === undefined ? S?.[a] : S?.[a]?.[b];
}
function throttle(fn, ms) {
  let last = 0,
    timer = null,
    val;
  return {
    push(v) {
      val = v;
      const wait = last + ms - performance.now();
      if (wait <= 0) {
        last = performance.now();
        fn(val);
      } else if (!timer)
        timer = setTimeout(() => {
          timer = null;
          last = performance.now();
          fn(val);
        }, wait);
    },
    flush(v) {
      clearTimeout(timer);
      timer = null;
      last = performance.now();
      fn(v);
    },
  };
}

// ---------- toast & modals ----------
let toastTimer;
function toast(text, kind = "info") {
  const t = $("#toast");
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 3500);
}
function modal(build) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    const box = document.createElement("div");
    box.className = "modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    back.append(box);
    $("#modal-root").append(back);
    const prev = document.activeElement;
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };
    function close(v) {
      back.remove();
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
      resolve(v);
    }
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) close(null);
    });
    document.addEventListener("keydown", onKey);
    build(box, close);
  });
}
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
function askName(title, message, value) {
  return modal((box, close) => {
    box.innerHTML = `<h4>${esc(title)}</h4><p>${esc(message)}</p><form><input maxlength="24" aria-label="Nombre del cue" value="${esc(value)}">
      <div class="btn-row"><button type="button" class="btn" data-c>Cancelar</button><button class="btn primary">Guardar</button></div></form>`;
    const input = $("input", box);
    $("[data-c]", box).onclick = () => close(null);
    $("form", box).onsubmit = (e) => {
      e.preventDefault();
      close(input.value.trim() || value);
    };
    input.focus();
    input.select();
  });
}
function confirmBox(title, message, okText, danger = true) {
  return modal((box, close) => {
    box.innerHTML = `<h4>${esc(title)}</h4><p>${esc(message)}</p><div class="btn-row"><button type="button" class="btn" data-c>Cancelar</button>
      <button type="button" class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okText)}</button></div>`;
    $("[data-c]", box).onclick = () => close(false);
    $("[data-ok]", box).onclick = () => close(true);
    $("[data-ok]", box).focus();
  });
}
function sheet(title, actions) {
  return modal((box, close) => {
    box.innerHTML = `<h4>${esc(title)}</h4><div class="sheet">${actions.map((a, i) => `<button type="button" class="btn ${a.cls || ""}" data-i="${i}">${esc(a.label)}</button>`).join("")}
      <button type="button" class="btn" data-c>Cancelar</button></div>`;
    $$("[data-i]", box).forEach((b) => {
      b.onclick = () => close(actions[+b.dataset.i].value);
    });
    $("[data-c]", box).onclick = () => close(null);
  });
}

// ---------- glyphs ----------
const GLYPHS = {
  circle: '<circle cx="12" cy="12" r="8"/>',
  square: '<rect x="5" y="5" width="14" height="14"/>',
  triangle: '<path d="M12 4l8 15H4z"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/>',
  heart:
    '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  line: '<path d="M4 12h16"/>',
  spiral:
    '<path d="M12 12a1.5 1.5 0 0 1 3 0a3 3 0 0 1-6 0a4.5 4.5 0 0 1 9 0a6 6 0 0 1-12 0a7.5 7.5 0 0 1 15 0"/>',
  wave: '<path d="M3 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0"/>',
  lissajous: '<path d="M12 12c3-6 8-6 8 0s-5 6-8 0-8-6-8 0 5 6 8 0z"/>',
  tunnel:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.8"/>',
  fan: '<path d="M12 20L4 7M12 20L8 4.8M12 20V4M12 20l4-15.2M12 20l8-13"/>',
  grid: '<path d="M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16"/>',
  flower:
    '<path d="M12 12C9 8 9 4 12 4s3 4 0 8zm0 0c4-3 8-3 8 0s-4 3-8 0zm0 0c3 4 3 8 0 8s-3-4 0-8zm0 0c-4 3-8 3-8 0s4-3 8 0z"/>',
  text: '<path d="M6 6h12M12 6v13"/>',
  drawing: '<path d="M4 17c3-6 5-9 7-6s2 6 5 3 3-7 4-9"/>',
};
const glyph = (id) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[id] || '<circle cx="12" cy="12" r="2"/>'}</svg>`;
const patternName = (id) => S?.patterns?.find((p) => p.id === id)?.name || id;

// ---------- bindings: state -> controls (skipping the control being touched) ----------
const bindings = [];
const bind = (key, apply) => bindings.push({ key, apply });
function applyBindings() {
  for (const b of bindings) {
    if (isBusy(b.key)) continue;
    const v = getValue(b.key);
    if (v !== undefined) b.apply(v);
  }
}

const FMT = {
  pct: (v) => `${Math.round(v * 100)}%`,
  deg: (v) => `${Math.round(v)}°`,
  dps: (v) => `${Math.round(v)}°/s`,
  pps: (v) => `${Math.round(v).toLocaleString("es-ES")} pps`,
  bpm: (v) => `${Math.round(v)}`,
};
function setupSlider(el) {
  const key = el.dataset.key,
    fmt = FMT[el.dataset.fmt] || String;
  const input = $("input", el),
    out = $("output", el);
  const min = +input.min,
    max = +input.max,
    zero = min < 0 ? (-min / (max - min)) * 100 : 0;
  const paint = () => {
    const f = ((+input.value - min) / (max - min)) * 100;
    out.textContent = fmt(+input.value);
    input.style.setProperty("--a", `${Math.min(f, zero)}%`);
    input.style.setProperty("--b", `${Math.max(f, zero)}%`);
  };
  const value = () =>
    key === "settings.pps" || key === "bpm"
      ? Math.round(+input.value)
      : +input.value;
  const th = throttle((v) => sendValue(key, v), SEND_MS);
  const end = () => {
    if (busy.get(key) === Infinity) release(key);
  };
  input.addEventListener("pointerdown", () => {
    hold(key);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  });
  input.addEventListener("input", () => {
    touch(key);
    paint();
    th.push(value());
  });
  input.addEventListener("change", () => {
    th.flush(value());
    end();
  });
  bind(key, (v) => {
    input.value = v;
    paint();
  });
  paint();
}
function selectChoice(el, v) {
  for (const b of $$("button[data-value]", el)) {
    const on = b.dataset.value === String(v);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  }
}
function setupChoice(el) {
  const key = el.dataset.key;
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    touch(key);
    selectChoice(el, b.dataset.value);
    sendValue(key, b.dataset.value);
  });
  bind(key, (v) => selectChoice(el, v));
}
const listCache = {};
function fillChoices(el) {
  const items = S?.[el.dataset.list] || [];
  const sig = JSON.stringify(items);
  if (listCache[el.id] === sig) return;
  listCache[el.id] = sig;
  const withGlyph = el.classList.contains("glyph-chips");
  el.innerHTML = items
    .map(
      (it) =>
        `<button type="button" role="radio" data-value="${esc(it.id)}">${withGlyph ? glyph(it.id) : ""}<span>${esc(it.name)}</span></button>`,
    )
    .join("");
}
function setupToggle(input) {
  const key = input.dataset.key;
  input.addEventListener("change", async () => {
    touch(key);
    const v = input.checked;
    if (key === "settings.beamSafety" && !v) {
      input.checked = true;
      hold(key);
      const ok = await confirmBox(
        "¿Desactivar la seguridad de haz?",
        "Sin ella, un haz quieto o casi quieto puede salir a plena potencia. Úsalo solo si sabes lo que haces.",
        "Desactivar",
      );
      release(key);
      if (!ok) return;
      input.checked = false;
    }
    sendValue(key, v);
  });
  bind(key, (v) => {
    input.checked = !!v;
  });
}

// ---------- top bar, arm ----------
function onStatus(status) {
  if (status === "open") {
    $("#conn-label").textContent = "Sincronizando…";
    return;
  }
  online = false;
  document.body.classList.add("offline");
  $("#banner").hidden = false;
  $("#conn-label").textContent = "Desconectado";
  cancelHold();
  renderArm();
}
function onMessage(msg) {
  if (msg.type === "state" && msg.state) applyState(msg.state);
  else if (msg.type === "frame") onFrame(msg);
  else if (msg.type === "error") toast(msg.message || "Error", "error");
}
function applyState(s) {
  S = s;
  if (!online) {
    online = true;
    document.body.classList.remove("offline");
    $("#banner").hidden = true;
    $("#conn-label").textContent = "Conectado";
  }
  if (S.armed) armPending = false;
  document.body.classList.toggle("armed", !!S.armed);
  const dac = $("#dac"),
    dacs = S.dacs || [];
  dac.classList.toggle("sim", !!S.simulated);
  dac.classList.toggle("real", !S.simulated && dacs.length > 0);
  dac.textContent = S.simulated
    ? "SIMULADOR"
    : dacs.length
      ? dacs[0].name + (dacs.length > 1 ? ` +${dacs.length - 1}` : "")
      : "SIN DAC";
  $$("[data-list]").forEach(fillChoices);
  renderArm();
  renderCues();
  applyBindings();
  renderDacs();
  renderScanArea();
  renderLiveBar();
  $("#fx-speed").classList.toggle("dim", !!S.scene?.beatSync);
}

const armBtn = $("#arm");
let holdStart = 0,
  holdRaf = 0,
  armPending = false,
  pendingTimer;
function renderArm() {
  const label = $("#arm-label");
  armBtn.classList.toggle("pending", armPending);
  let text = "MANTÉN PARA EMITIR",
    aria = "Mantén pulsado para emitir";
  if (!online) text = aria = "SIN CONEXIÓN";
  else if (S?.armed) {
    text = "EN VIVO — TOCA PARA APAGAR";
    aria = "En vivo: toca para apagar";
  } else if (armPending) text = "ACTIVANDO…";
  label.textContent = text;
  armBtn.setAttribute("aria-label", aria);
  const st = $("#arm-state");
  st.textContent = S?.armed ? "EN VIVO" : armPending ? "ACTIVANDO…" : "EN ESPERA";
  st.classList.toggle("live", online && !!S?.armed);
}
function blackout() {
  cancelHold();
  send({ type: "blackout" });
}
function startHold() {
  if (!online || S?.armed || holdStart) return;
  holdStart = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - holdStart) / HOLD_MS);
    armBtn.style.setProperty("--p", p);
    if (p >= 1) {
      holdStart = 0;
      armBtn.style.setProperty("--p", 0);
      armPending = true;
      renderArm();
      navigator.vibrate?.(40);
      send({ type: "arm", armed: true });
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        armPending = false;
        renderArm();
      }, 2000);
      return;
    }
    holdRaf = requestAnimationFrame(step);
  };
  holdRaf = requestAnimationFrame(step);
}
function cancelHold() {
  if (!holdStart) return;
  const short = performance.now() - holdStart < HOLD_MS * 0.5;
  holdStart = 0;
  cancelAnimationFrame(holdRaf);
  armBtn.style.setProperty("--p", 0);
  if (short) toast("Mantén pulsado para emitir");
}
armBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (S?.armed) {
    blackout();
    return;
  } // act on touch-down: fastest possible stop
  armBtn.setPointerCapture?.(e.pointerId);
  startHold();
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((t) =>
  armBtn.addEventListener(t, cancelHold),
);
armBtn.addEventListener("contextmenu", (e) => e.preventDefault());
armBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.repeat) {
    e.preventDefault();
    S?.armed ? blackout() : startHold();
  }
});
armBtn.addEventListener("keyup", (e) => {
  if (e.key === "Enter") cancelHold();
});
document.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key === "Escape") blackout();
  else if (
    e.key === " " &&
    !e.target.matches?.("input[type=text], textarea, .modal input")
  ) {
    e.preventDefault();
    blackout();
  }
});
document.addEventListener("gesturestart", (e) => e.preventDefault());

// ---------- preview ----------
const BLANK_HOLD_MS = 400; // keep the beam-safety badge up this long after the last blanked frame (no flashing)
const preview = $("#preview"),
  pctx = preview.getContext("2d"),
  scanLabel = $("#scan-label"),
  blankBadge = $("#blank-badge");
let frameStrokes = [],
  previewRaf = 0,
  guides = null, // cached static layer (grid, crosshair, full range, scan area)
  guidesKey = "",
  scanSize = null, // as last reported by the server (the real output, not the slider being dragged)
  blankedAt = -Infinity,
  blankShown = false;
function paintPreview() {
  previewRaf = 0;
  fitCanvas(preview);
  const key = `${preview.width}x${preview.height}@${scanSize}`;
  if (key !== guidesKey) {
    guides = drawGuides(guides, preview.width, preview.height, scanSize ?? 1);
    guidesKey = key;
  }
  drawStrokes(pctx, frameStrokes, guides);
}
const invalidatePreview = () => {
  if (!previewRaf) previewRaf = requestAnimationFrame(paintPreview);
};
function renderScanArea() {
  const s = S?.settings?.scanSize;
  if (typeof s !== "number" || s === scanSize) return;
  scanSize = s;
  scanLabel.textContent = `ÁREA DE ESCANEO ${Math.round(s * 100)}%`;
  scanLabel.hidden = false;
  scanLabel.classList.toggle("outside", s < 0.4); // too small to hold the label: put it under the rectangle
  $("#preview-wrap").style.setProperty("--scan", s);
  invalidatePreview();
}
function onFrame(msg) {
  frameStrokes = Array.isArray(msg.strokes) ? msg.strokes : [];
  $("#fps").textContent = Math.round(msg.fps || 0);
  $("#pts").textContent = msg.points ?? 0;
  const now = performance.now();
  if (msg.blanked) blankedAt = now;
  const show = now - blankedAt < BLANK_HOLD_MS;
  if (show !== blankShown) {
    blankShown = show;
    blankBadge.hidden = !show;
  }
  invalidatePreview();
}
new ResizeObserver(invalidatePreview).observe(preview);

// ---------- cues ----------
const cueGrid = $("#cue-grid");
let saveMode = false;
for (let i = 0; i < CUES; i++) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cue empty";
  b.dataset.index = i;
  // art: the pattern glyph, covered by the live thumbnail once thumbs.js has loaded (the glyph is the fallback)
  b.innerHTML = `<span class="art"><span class="glyph"></span></span><span class="meta"><span class="num">${i + 1}</span><span class="name">Vacío</span></span>`;
  let timer = 0,
    longFired = false,
    x0 = 0,
    y0 = 0;
  b.addEventListener("pointerdown", (e) => {
    longFired = false;
    x0 = e.clientX;
    y0 = e.clientY;
    clearTimeout(timer);
    if (S?.cues?.[i] && !saveMode)
      timer = setTimeout(() => {
        longFired = true;
        cueActions(i);
      }, HOLD_MS);
  });
  b.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - x0, e.clientY - y0) > 12) clearTimeout(timer);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) =>
    b.addEventListener(t, () => clearTimeout(timer)),
  );
  b.addEventListener("contextmenu", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    if (longFired) {
      longFired = false;
      return;
    }
    cueTap(i);
  });
  cueGrid.append(b);
}
function renderCues() {
  const cues = S?.cues || [];
  $$(".cue", cueGrid).forEach((b, i) => {
    const c = cues[i];
    b.classList.toggle("empty", !c);
    b.classList.toggle("active", S?.activeCue === i);
    b.style.setProperty(
      "--c",
      c?.scene?.colorMode && c.scene.colorMode !== "solid"
        ? "var(--text)"
        : c?.scene?.color || "",
    );
    const g = $(".glyph", b),
      art = c ? glyph(c.scene?.pattern) : "";
    if (g.dataset.html !== art) {
      g.innerHTML = art;
      g.dataset.html = art;
    }
    const name = $(".name", b),
      label = c ? c.name : "Vacío";
    if (name.textContent !== label) name.textContent = label;
    b.setAttribute(
      "aria-label",
      c ? `Cue ${i + 1}: ${c.name}` : `Cue ${i + 1}: vacío`,
    );
    b.setAttribute("aria-pressed", S?.activeCue === i);
  });
  try {
    thumbs?.update(S);
  } catch (err) {
    console.warn("cue thumbnails:", err); // never let them break the state update
  }
}
// Live cue thumbnails, loaded on the side: if the module cannot load, the cues keep their glyphs and nothing else
// (above all the arm / blackout control) depends on it.
import("./thumbs.js")
  .then((m) => {
    $$(".cue", cueGrid).forEach((b, i) => m.attach(i, $(".art", b)));
    thumbs = m;
    renderCues();
  })
  .catch(() => {
    /* glyph fallback */
  });
function setSaveMode(on) {
  saveMode = on;
  $("#save-mode").setAttribute("aria-pressed", on);
  $("#save-hint").hidden = !on;
  cueGrid.classList.toggle("saving", on);
}
$("#save-mode").addEventListener("click", () => setSaveMode(!saveMode));
async function cueTap(i) {
  const c = S?.cues?.[i];
  if (saveMode) {
    const name = await askName(
      `Guardar en cue ${i + 1}`,
      c
        ? `Se sustituirá «${c.name}» por la escena en vivo actual.`
        : "Se guardará la escena en vivo actual.",
      c?.name || patternName(S?.scene?.pattern),
    );
    if (name) {
      send({ type: "saveCue", index: i, name });
      setSaveMode(false);
    }
  } else if (c) send({ type: "cue", index: i });
  else toast("Ranura vacía · usa «Guardar» para almacenar la escena");
}
async function cueActions(i) {
  const c = S?.cues?.[i];
  if (!c) return;
  const act = await sheet(`Cue ${i + 1}: ${c.name}`, [
    { label: "Renombrar", value: "rename" },
    { label: "Borrar", value: "clear", cls: "danger" },
  ]);
  if (act === "rename") {
    const name = await askName(
      `Renombrar cue ${i + 1}`,
      "Atención: renombrar guarda la escena en vivo actual en este cue.",
      c.name,
    );
    if (name) send({ type: "saveCue", index: i, name });
  } else if (
    act === "clear" &&
    (await confirmBox(
      `¿Borrar «${c.name}»?`,
      `El cue ${i + 1} quedará vacío.`,
      "Borrar",
    ))
  ) {
    send({ type: "clearCue", index: i });
  }
}

// ---------- XY pad ----------
const pad = $("#xy-pad"),
  dot = $("#xy-dot");
function showXY(x, y) {
  dot.style.left = `${((x + 1) / 2) * 100}%`;
  dot.style.top = `${((1 - y) / 2) * 100}%`;
  $("#xy-read").textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)}`;
}
{
  let dragging = false,
    lastTap = 0,
    lastXY = [0, 0],
    cur = [0, 0];
  const th = throttle(
    ([x, y]) => send({ type: "scene", scene: { x, y } }),
    SEND_MS,
  );
  const at = (e) => {
    const r = pad.getBoundingClientRect(),
      cl = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000;
    return [
      cl(((e.clientX - r.left) / r.width) * 2 - 1),
      cl(1 - ((e.clientY - r.top) / r.height) * 2),
    ];
  };
  const setKeys = (fn) => {
    fn("scene.x");
    fn("scene.y");
  };
  pad.addEventListener("pointerdown", (e) => {
    const now = performance.now(),
      p = at(e);
    pad.setPointerCapture(e.pointerId);
    setKeys(hold);
    if (
      now - lastTap < 320 &&
      Math.hypot(p[0] - lastXY[0], p[1] - lastXY[1]) < 0.25
    ) {
      lastTap = 0;
      dragging = false;
      cur = [0, 0];
      showXY(0, 0);
      th.flush([0, 0]);
      return;
    }
    lastTap = now;
    lastXY = p;
    dragging = true;
    cur = p;
    showXY(...p);
    th.push(p);
  });
  pad.addEventListener("pointermove", (e) => {
    if (dragging) {
      cur = at(e);
      showXY(...cur);
      th.push(cur);
    }
  });
  const end = () => {
    if (dragging) th.flush(cur);
    dragging = false;
    setKeys(release);
  };
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);
  let bx = 0,
    by = 0;
  bind("scene.x", (v) => {
    bx = v;
    showXY(bx, by);
  });
  bind("scene.y", (v) => {
    by = v;
    showXY(bx, by);
  });
}

// ---------- colour ----------
const colorInput = $("#color-input");
{
  const th = throttle((c) => sendValue("scene.color", c), SEND_MS);
  const pick = (e) => {
    const b = e.target.closest("[data-color]");
    if (b) {
      touch("scene.color");
      showColor(b.dataset.color);
      sendValue("scene.color", b.dataset.color);
    }
  };
  $("#swatches").addEventListener("click", pick);
  $("#quick-colors").addEventListener("click", pick); // live bar
  colorInput.addEventListener("input", () => {
    touch("scene.color");
    showColor(colorInput.value);
    th.push(colorInput.value);
  });
  colorInput.addEventListener("change", () => th.flush(colorInput.value));
  bind("scene.color", showColor);
}
function showColor(c) {
  c = String(c).toLowerCase();
  $$("#swatches [data-color], #quick-colors [data-color]").forEach((b) => {
    const on = b.dataset.color === c;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  if (colorInput.value !== c) colorInput.value = c;
  $("#cc-preview").style.setProperty("--cc", c);
  $("#cc-hex").textContent = c;
}

// ---------- tempo ----------
{
  for (const tap of [$("#tap"), $("#live-tap")]) {
    const flash = () => {
      tap.classList.add("flash");
      setTimeout(() => tap.classList.remove("flash"), 90);
    };
    tap.addEventListener("pointerdown", () => {
      send({ type: "tap" });
      flash();
    }); // touch-down for timing accuracy
    tap.addEventListener("click", (e) => {
      if (e.detail === 0) {
        send({ type: "tap" });
        flash();
      }
    }); // keyboard
  }
  const nudge = (d) => {
    touch("bpm");
    sendValue(
      "bpm",
      Math.max(40, Math.min(240, Math.round((S?.bpm ?? 120) + d))),
    );
  };
  $("#bpm-minus").addEventListener("click", () => nudge(-1));
  $("#bpm-plus").addEventListener("click", () => nudge(1));
  bind("bpm", (v) => {
    $("#bpm-value").textContent = Math.round(v * 10) / 10;
  });
}

// ---------- live bar (BPM readouts, effect chip) ----------
const setText = (el, t) => {
  if (el.textContent !== t) el.textContent = t;
};
function renderLiveBar() {
  // straight from the state, not a binding: the readouts follow the real tempo even while the BPM slider is held
  const bpm = String(Math.round((S?.bpm ?? 120) * 10) / 10);
  setText($("#strip-bpm"), bpm);
  setText($("#live-bpm"), bpm);
  const fx = S?.scene?.effect,
    name = S?.effects?.find((e) => e.id === fx)?.name || fx || "—";
  const chip = $("#fx-chip");
  setText($("#fx-name"), name);
  chip.classList.toggle("on", !!fx && fx !== "none");
  chip.setAttribute("aria-label", `Efecto: ${name}. Abrir el panel de efectos`);
}
$("#fx-chip").addEventListener("click", () => showTab("fx"));

// ---------- text ----------
{
  const input = $("#text-input");
  let timer;
  const count = () => {
    $("#text-count").textContent = `${input.value.length}/64`;
  };
  input.addEventListener("input", () => {
    touch("scene.text");
    count();
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        send({ type: "scene", scene: { pattern: "text", text: input.value } }),
      150,
    );
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  bind("scene.text", (v) => {
    if (document.activeElement !== input) {
      input.value = v;
      count();
    }
  });
}

// ---------- drawing ----------
const draw = $("#draw"),
  dctx = draw.getContext("2d");
let strokes = [],
  current = null,
  drawRaf = 0;
function paintDraw() {
  drawRaf = 0;
  fitCanvas(draw);
  const hex = (S?.scene?.color || "#00ff00").replace("#", ""),
    n = parseInt(hex, 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  drawStrokes(
    dctx,
    strokes.map((s) => s.flatMap(([x, y]) => [x, y, ...rgb])),
    true,
  );
  $("#draw-count").textContent =
    `${strokes.reduce((a, s) => a + s.length, 0)} / ${MAX_DRAW_PTS} puntos`;
}
const invalidateDraw = () => {
  if (!drawRaf) drawRaf = requestAnimationFrame(paintDraw);
};
new ResizeObserver(invalidateDraw).observe(draw);
function commitDrawing() {
  touch("scene.drawing");
  send({ type: "scene", scene: { pattern: "drawing", drawing: strokes } });
  invalidateDraw();
}
function drawPoint(e) {
  const r = draw.getBoundingClientRect(),
    cl = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000;
  return [
    cl(((e.clientX - r.left) / r.width) * 2 - 1),
    cl(1 - ((e.clientY - r.top) / r.height) * 2),
  ];
}
draw.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  draw.setPointerCapture(e.pointerId);
  hold("scene.drawing");
  current = [drawPoint(e)];
  strokes.push(current);
  invalidateDraw();
});
draw.addEventListener("pointermove", (e) => {
  if (!current) return;
  for (const ev of e.getCoalescedEvents?.() || [e]) {
    const p = drawPoint(ev),
      last = current[current.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.01) current.push(p);
  }
  invalidateDraw();
});
function endStroke() {
  if (!current) return;
  if (current.length < 2) strokes.pop();
  current = null;
  release("scene.drawing");
  commitDrawing();
}
draw.addEventListener("pointerup", endStroke);
draw.addEventListener("pointercancel", endStroke);
$("#draw-undo").addEventListener("click", () => {
  strokes.pop();
  commitDrawing();
});
$("#draw-clear").addEventListener("click", () => {
  strokes = [];
  commitDrawing();
});
bind("scene.drawing", (v) => {
  if (current) return;
  strokes = Array.isArray(v) ? v.map((s) => s.map((p) => [p[0], p[1]])) : [];
  invalidateDraw();
});

// ---------- settings ----------
function renderDacs() {
  const kinds = { usb: "USB", idn: "Red (IDN)", sim: "Simulador" };
  $("#dac-list").innerHTML =
    (S?.dacs || [])
      .map(
        (d) =>
          `<li>${esc(d.name)} <span>${esc(kinds[d.kind] || d.kind)}</span></li>`,
      )
      .join("") || "<li>Ningún DAC encontrado</li>";
  const webusb = S?.transport === "webusb";
  $("#rescan span").textContent = webusb ? "Conectar DAC por USB" : "Buscar DAC";
  $("#rescan").disabled = !online || !!S?.armed || (webusb && !S?.usbSupported);
  const hint =
    webusb && !S?.usbSupported
      ? "Este navegador no puede usar USB: abre la página en Chrome o Edge (Android o computadora)."
      : S?.armed
        ? "Solo disponible con la emisión apagada."
        : webusb
          ? "Conecta el Helios por USB (en Android, con un cable OTG) y elígelo en la ventana del navegador. Vuelve a tocar aquí si lo desconectas o reinicias el navegador."
          : "";
  $("#rescan-hint").textContent = hint;
  $("#rescan-hint").hidden = !hint;
}
$("#rescan").addEventListener("click", () => {
  send({ type: "rescan" });
  if (S?.transport !== "webusb") toast("Buscando DAC…");
});

// ---------- tabs ----------
// Phones: Cues is one of the tabs and shares the panel area. Tablet and desktop (the same media query as app.css):
// the cue grid is always on screen and the tabs switch only the control panel.
const wideQuery = matchMedia("(min-width: 600px) and (min-height: 520px)");
const cuesPane = $("#page-cues"),
  panel = $("#panel");
let tabPref = "cues", // the user's last choice
  panelTab = "shape", // the last control tab (what wide layouts show)
  shownTab = "";
function renderTabs() {
  const wide = wideQuery.matches,
    active = wide && tabPref === "cues" ? panelTab : tabPref;
  $$(".tabbar [role=tab]").forEach((t) =>
    t.setAttribute("aria-selected", t.dataset.tab === active),
  );
  $$(".page", panel).forEach((p) => {
    p.hidden = p.dataset.page !== active;
  });
  cuesPane.hidden = !wide && active !== "cues";
  cuesPane.setAttribute("role", wide ? "region" : "tabpanel");
  cuesPane.setAttribute("aria-label", "Cues");
  panel.hidden = !wide && active === "cues";
  $("#fx-chip").classList.toggle("open", active === "fx" && !panel.hidden);
  if (active !== shownTab) {
    shownTab = active;
    panel.scrollTop = 0;
    if (active === "draw") invalidateDraw();
  }
}
function showTab(name) {
  tabPref = name;
  if (name !== "cues") panelTab = name;
  renderTabs();
  try {
    localStorage.setItem("helios.tab", name);
  } catch {
    /* storage unavailable */
  }
}
$(".tabbar").addEventListener("click", (e) => {
  const t = e.target.closest("[data-tab]");
  if (t) showTab(t.dataset.tab);
});
// Safari < 14 only has addListener
if (wideQuery.addEventListener) wideQuery.addEventListener("change", renderTabs);
else wideQuery.addListener?.(renderTabs);

$$(".slider[data-key]").forEach(setupSlider);
$$(".seg[data-key], .chips[data-key]").forEach(setupChoice);
$$("input[type=checkbox][data-key]").forEach(setupToggle);
let initialTab = "cues";
try {
  initialTab = localStorage.getItem("helios.tab") || "cues";
} catch {
  /* storage unavailable */
}
if (!$(`[data-tab="${initialTab}"]`)) initialTab = "cues";
showTab(initialTab);
renderArm();
renderCues();
