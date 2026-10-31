// Transport selection. Served by the Python server (python -m helios_web) -> WebSocket to it. Served as a static
// site (e.g. dac.ferchx.com) -> the in-browser engine, which drives the DAC over WebUSB (engine/local.js).
// static/runtime.json says {"mode": "webusb"}; the Python server answers {"mode": "server"}. Only a definite answer
// picks a transport: a failed or slow probe retries (shown as disconnected) instead of silently falling back to the
// simulator, which on a LAN would leave the real laser unreachable. "?modo=usb" forces the in-browser engine.
export function connect(handlers) {
  let impl = null,
    attempt = 0;
  const params = new URLSearchParams(location.search);
  const forced = params.get("modo") === "usb";

  function probe() {
    if (forced) return Promise.resolve("webusb");
    // AbortController + timer rather than AbortSignal.timeout(), which older Safari (iOS 15) lacks
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    // the timeout grows with each attempt, so a slow but working link still gets a definite answer
    const timer = setTimeout(() => ctl?.abort(), Math.min(20000, 2500 * 2 ** attempt));
    return fetch("/static/runtime.json", { cache: "no-store", signal: ctl?.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => info?.mode ?? null)
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  function retry() {
    handlers.onStatus("closed");
    const delay = Math.min(5000, 300 * 2 ** attempt++);
    setTimeout(() => probe().then(start), delay);
  }

  async function start(mode) {
    if (mode === "server") {
      impl = connectSocket(handlers);
    } else if (mode === "webusb") {
      try {
        const { LocalBackend } = await import("./engine/local.js");
        const backend = new LocalBackend(handlers);
        backend.start();
        impl = backend;
        if (params.has("recarga")) {
          params.delete("recarga");
          const query = params.toString();
          history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
        }
      } catch (err) {
        // A module that failed to load stays failed for this document, so retrying here can never work.
        // Reload once (nothing is connected yet, no DAC is open); after that, ask the user.
        handlers.onStatus("closed");
        if (!params.has("recarga")) {
          handlers.onMessage({ type: "error", message: "No se pudo cargar la app. Recargando…" });
          params.set("recarga", "1");
          setTimeout(() => location.replace(`${location.pathname}?${params}${location.hash}`), 1500);
        } else {
          const message = `No se pudo cargar la app (${err?.message || err}). Revisa la conexión y recarga la página.`;
          handlers.onMessage({ type: "error", message });
          setInterval(() => handlers.onMessage({ type: "error", message }), 6000);
        }
      }
    } else {
      retry();
    }
  }

  probe().then(start);
  return { send: (obj) => (impl ? impl.send(obj) : false) };
}

// WebSocket connection with capped exponential backoff and a stale-socket watchdog.
// Nothing is queued while disconnected: send() simply returns false.
function connectSocket({ onMessage, onStatus }) {
  let ws = null,
    attempt = 0,
    timer = 0,
    lastMsg = 0;
  const url = () =>
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  function drop() {
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    ws = null;
    onStatus("closed");
    schedule();
  }
  function open() {
    clearTimeout(timer);
    timer = 0;
    try {
      ws = new WebSocket(url());
    } catch {
      ws = null;
      onStatus("closed");
      schedule();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      lastMsg = performance.now();
      onStatus("open");
    };
    ws.onmessage = (ev) => {
      lastMsg = performance.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg === "object") onMessage(msg);
    };
    ws.onclose = drop;
  }
  function schedule() {
    if (timer) return;
    const delay = Math.min(
      5000,
      300 * 2 ** attempt * (0.8 + Math.random() * 0.4),
    );
    attempt++;
    timer = setTimeout(open, delay);
  }
  // The server streams ~20 frames/s; silence means a dead link (e.g. Wi-Fi dropped).
  setInterval(() => {
    if (ws?.readyState === 1 && performance.now() - lastMsg > 4000) drop();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !ws) {
      attempt = 0;
      open();
    }
  });
  open();
  return {
    send: (obj) =>
      ws?.readyState === 1 ? (ws.send(JSON.stringify(obj)), true) : false,
  };
}
