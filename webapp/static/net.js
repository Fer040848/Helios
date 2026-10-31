// Transport selection. Served by the Python server (python -m helios_web) -> WebSocket to it. Served as a static
// site (e.g. dac.ferchx.com) -> the in-browser engine, which drives the DAC over WebUSB (engine/local.js).
// "?modo=usb" forces the in-browser engine.
export function connect(handlers) {
  let impl = null;
  const forced = new URLSearchParams(location.search).get("modo") === "usb";
  // static/runtime.json says {"mode": "webusb"} on a static host; the Python server answers {"mode": "server"}.
  const probe = forced
    ? Promise.resolve(false)
    : fetch("/static/runtime.json", { cache: "no-store", signal: AbortSignal.timeout(2500) })
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => info?.mode === "server")
        .catch(() => false);
  probe.then(async (hasServer) => {
    if (hasServer) {
      impl = connectSocket(handlers);
    } else {
      const { LocalBackend } = await import("./engine/local.js");
      impl = new LocalBackend(handlers);
      impl.start();
    }
  });
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
