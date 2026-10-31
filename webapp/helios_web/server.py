"""aiohttp app: static files, ``GET /api/state`` and the ``/ws`` WebSocket (protocol in DESIGN.md).

Each client has its own sender task with latest-only slots for ``state`` and ``frame`` plus a queue for error
replies, so a slow phone only drops its own preview frames and never stalls the others.
"""

import asyncio
import json
import logging
import mimetypes
import os

from aiohttp import WSMsgType, web

log = logging.getLogger(__name__)

STATIC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"
)
FRAME_INTERVAL = 0.05  # ~20 preview frames per second
STATE_INTERVAL = 0.1  # state broadcasts coalesced to <= 10 per second
MAX_PREVIEW_VERTICES = 1500

mimetypes.add_type(
    "text/javascript", ".js"
)  # Windows registries sometimes map .js to text/plain
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")

ENGINE = web.AppKey("engine", object)
CLIENTS = web.AppKey("clients", set)
STATIC = web.AppKey("static", str)


def _dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def frame_message(strokes, fps, points):
    """Encode preview strokes as flat ``[x, y, r, g, b, ...]`` lists, downsampled to MAX_PREVIEW_VERTICES."""
    total = sum(len(st.points) + (1 if st.closed else 0) for st in strokes)
    step = max(1, -(-total // MAX_PREVIEW_VERTICES))
    out = []
    for st in strokes:
        pts = (
            list(st.points[::step])
            if step > 1 and len(st.points) > 2
            else list(st.points)
        )
        if st.closed and len(pts) > 1:
            pts.append(pts[0])  # the wire format has no closed flag
        flat = []
        for x, y, r, g, b in pts:
            flat.extend(
                (
                    round(x, 3),
                    round(y, 3),
                    round(r * 255),
                    round(g * 255),
                    round(b * 255),
                )
            )
        out.append(flat)
    return _dumps(
        {"type": "frame", "strokes": out, "fps": round(fps, 1), "points": points}
    )


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.state = None
        self.frame = None
        self.errors = []
        self.wake = asyncio.Event()

    def push(self, kind, text):
        if kind == "error":
            self.errors.append(text)
        else:
            setattr(self, kind, text)
        self.wake.set()

    async def run(self):
        while not self.ws.closed:
            await self.wake.wait()
            self.wake.clear()
            for slot in ("errors", "state", "frame"):
                if slot == "errors":
                    pending, self.errors = self.errors, []
                else:
                    pending = [getattr(self, slot)] if getattr(self, slot) else []
                    setattr(self, slot, None)
                for text in pending:
                    try:
                        await self.ws.send_str(text)
                    except (ConnectionError, RuntimeError):
                        return


def _error(message):
    return _dumps({"type": "error", "message": message})


async def handle_message(engine, data):
    """Apply one client message. Returns an error string, or None."""
    if not isinstance(data, dict):
        return "Mensaje inválido"
    kind = data.get("type")
    try:
        if kind == "scene":
            engine.update_scene(data.get("scene"))
        elif kind == "settings":
            engine.update_settings(data.get("settings"))
        elif kind == "arm":
            if not isinstance(data.get("armed"), bool):
                return "Falta 'armed'"
            await asyncio.get_running_loop().run_in_executor(
                None, engine.arm, data["armed"]
            )
        elif kind == "blackout":
            await asyncio.get_running_loop().run_in_executor(None, engine.blackout)
        elif kind == "cue":
            engine.trigger_cue(data.get("index"))
        elif kind == "saveCue":
            engine.save_cue(data.get("index"), data.get("name"))
        elif kind == "clearCue":
            engine.clear_cue(data.get("index"))
        elif kind == "tap":
            engine.tap()
        elif kind == "bpm":
            engine.set_bpm(data.get("bpm"))
        elif kind == "rescan":
            await asyncio.get_running_loop().run_in_executor(None, engine.rescan)
        else:
            return f"Tipo de mensaje desconocido: {kind!r}"
    except (ValueError, RuntimeError) as exc:
        return str(exc)
    return None


async def ws_handler(request):
    engine, clients = request.app[ENGINE], request.app[CLIENTS]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
    await ws.prepare(request)
    client = Client(ws)
    client.push("state", _dumps({"type": "state", "state": engine.get_state()}))
    sender = asyncio.create_task(client.run())
    clients.add(client)
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                client.push("error", _error("JSON inválido"))
                continue
            error = await handle_message(engine, data)
            if error:
                client.push("error", _error(error))
    finally:
        clients.discard(client)
        client.wake.set()
        sender.cancel()
    return ws


async def broadcaster(app):
    engine, clients = app[ENGINE], app[CLIENTS]
    loop = asyncio.get_running_loop()
    sent_version, last_state = -1, 0.0
    while True:
        await asyncio.sleep(FRAME_INTERVAL)
        if not clients:
            continue
        now = loop.time()
        if engine.version != sent_version and now - last_state >= STATE_INTERVAL:
            sent_version, last_state = engine.version, now
            text = _dumps({"type": "state", "state": engine.get_state()})
            for client in list(clients):
                client.push("state", text)
        text = frame_message(*engine.frame_snapshot())
        for client in list(clients):
            client.push("frame", text)


async def api_state(request):
    return web.Response(
        text=_dumps(request.app[ENGINE].get_state()), content_type="application/json"
    )


def _static_response(path):
    if not os.path.isfile(path):
        raise web.HTTPNotFound(text="No encontrado")
    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


async def index(request):
    return _static_response(os.path.join(request.app[STATIC], "index.html"))


async def static_file(request):
    root = os.path.realpath(request.app[STATIC])
    path = os.path.realpath(os.path.join(root, request.match_info["path"]))
    if not path.startswith(root + os.sep):
        raise web.HTTPNotFound(text="No encontrado")
    return _static_response(path)


def create_app(engine, static_dir=STATIC_DIR):
    app = web.Application()
    app[ENGINE] = engine
    app[CLIENTS] = set()
    app[STATIC] = static_dir
    app.router.add_get("/", index)
    app.router.add_get("/static/{path:.+}", static_file)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/ws", ws_handler)

    async def background(app):
        task = asyncio.create_task(broadcaster(app))
        yield
        task.cancel()
        for client in list(app[CLIENTS]):
            await client.ws.close()

    app.cleanup_ctx.append(background)
    return app
