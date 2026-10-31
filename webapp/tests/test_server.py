import asyncio
import json
import os
import tempfile
import unittest

from aiohttp.test_utils import TestClient, TestServer

from helios_web.engine import Engine
from helios_web.server import create_app
from tests.test_engine import FakeOutput


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with open(os.path.join(self.tmp.name, "index.html"), "w") as fh:
            fh.write("<!doctype html><title>ok</title>")
        with open(os.path.join(self.tmp.name, "app.js"), "w") as fh:
            fh.write("export {};")
        self.output = FakeOutput(dacs=1)
        self.engine = Engine(self.output, sleep=lambda s: None)
        self.engine.open()
        self.engine.render(0.0)
        self.client = TestClient(
            TestServer(create_app(self.engine, static_dir=self.tmp.name))
        )
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def receive(self, ws, kind, predicate=lambda d: True, timeout=2.0):
        async def loop():
            while True:
                data = json.loads((await ws.receive()).data)
                if data["type"] == kind and predicate(data):
                    return data

        return await asyncio.wait_for(loop(), timeout)

    async def test_api_state_shape(self):
        resp = await self.client.get("/api/state")
        self.assertEqual(resp.status, 200)
        state = await resp.json()
        for key in (
            "armed",
            "simulated",
            "dacs",
            "scene",
            "settings",
            "cues",
            "activeCue",
            "bpm",
            "patterns",
            "effects",
            "colorModes",
        ):
            self.assertIn(key, state)
        self.assertFalse(state["armed"])
        self.assertEqual(len(state["cues"]), 16)
        self.assertEqual(len(state["patterns"]), 15)

    async def test_static_files_and_traversal(self):
        self.assertEqual((await self.client.get("/")).status, 200)
        resp = await self.client.get("/static/app.js")
        self.assertEqual(resp.status, 200)
        self.assertIn("javascript", resp.headers["Content-Type"])
        self.assertEqual((await self.client.get("/static/missing.css")).status, 404)
        self.assertEqual(
            (await self.client.get("/static/..%2f..%2fserver.py")).status, 404
        )

    async def test_runtime_info_selects_the_websocket_transport(self):
        resp = await self.client.get("/static/runtime.json")
        self.assertEqual((await resp.json())["mode"], "server")

    async def test_missing_static_dir_is_404_not_crash(self):
        app = create_app(self.engine, static_dir=os.path.join(self.tmp.name, "nope"))
        async with TestClient(TestServer(app)) as client:
            self.assertEqual((await client.get("/")).status, 404)

    async def test_ws_state_arm_frames_blackout(self):
        ws = await self.client.ws_connect("/ws")
        first = await self.receive(ws, "state")
        self.assertFalse(first["state"]["armed"])
        await ws.send_json({"type": "arm", "armed": True})
        await self.receive(ws, "state", lambda d: d["state"]["armed"])
        frame = await self.receive(ws, "frame")
        self.assertTrue(frame["strokes"])
        x, y, r, g, b = frame["strokes"][0][:5]
        self.assertTrue(-1 <= x <= 1 and isinstance(r, int))
        await ws.send_json({"type": "blackout"})
        await self.receive(ws, "state", lambda d: not d["state"]["armed"])
        self.assertIn(("stop", 0), self.output.calls)
        await ws.close()

    async def test_invalid_messages_get_error_and_keep_connection(self):
        ws = await self.client.ws_connect("/ws")
        await self.receive(ws, "state")
        for bad in (
            "not json",
            json.dumps({"type": "nope"}),
            json.dumps({"type": "cue", "index": 99}),
            json.dumps([1, 2]),
            json.dumps({"type": "arm"}),
        ):
            await ws.send_str(bad)
            await self.receive(ws, "error")
        await ws.send_json({"type": "scene", "scene": {"pattern": "star"}})
        state = await self.receive(
            ws, "state", lambda d: d["state"]["scene"]["pattern"] == "star"
        )
        self.assertIsNone(state["state"]["activeCue"])
        await ws.close()

    async def test_lone_surrogate_does_not_stop_broadcasts(self):
        ws = await self.client.ws_connect("/ws")
        await self.receive(ws, "state")
        await ws.send_str('{"type": "scene", "scene": {"text": "A\\ud800"}}')
        await ws.send_str('{"type": "saveCue", "index": 15, "name": "B\\udc00"}')
        state = await self.receive(ws, "state", lambda d: d["state"]["cues"][15] is not None)
        self.assertEqual(state["state"]["scene"]["text"], "A?")
        self.assertEqual(state["state"]["cues"][15]["name"], "B?")
        await ws.send_json({"type": "arm", "armed": True})
        await self.receive(ws, "state", lambda d: d["state"]["armed"])   # still delivering after the bad text
        await ws.close()

    async def test_huge_number_keeps_the_connection(self):
        ws = await self.client.ws_connect("/ws")
        await self.receive(ws, "state")
        await ws.send_str('{"type": "settings", "settings": {"pps": 1' + "0" * 400 + '}}')
        await ws.send_json({"type": "scene", "scene": {"pattern": "heart"}})
        state = await self.receive(ws, "state", lambda d: d["state"]["scene"]["pattern"] == "heart")
        self.assertEqual(state["state"]["settings"]["pps"], 30000)
        await ws.close()

    async def test_rescan_while_armed_is_an_error(self):
        ws = await self.client.ws_connect("/ws")
        await self.receive(ws, "state")
        await ws.send_json({"type": "arm", "armed": True})
        await self.receive(ws, "state", lambda d: d["state"]["armed"])
        await ws.send_json({"type": "rescan"})
        error = await self.receive(ws, "error")
        self.assertIn("Apaga", error["message"])
        await ws.close()

    async def test_state_broadcast_to_other_clients(self):
        a = await self.client.ws_connect("/ws")
        b = await self.client.ws_connect("/ws")
        await self.receive(a, "state")
        await self.receive(b, "state")
        await a.send_json({"type": "cue", "index": 2})
        state = await self.receive(b, "state", lambda d: d["state"]["activeCue"] == 2)
        self.assertEqual(state["state"]["scene"]["pattern"], "star")
        await a.close()
        await b.close()


if __name__ == "__main__":
    unittest.main()
