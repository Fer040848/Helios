"""CLI: ``python -m helios_web [--host H] [--port P] [--simulate] [--lib PATH] [--data DIR]``."""

import argparse
import asyncio
import logging
import os
import socket

from aiohttp import web

from .engine import Engine
from .output import create_output
from .server import create_app
from .store import Store

DEFAULT_DATA = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
)


def lan_addresses():
    """Best-effort LAN IPv4 addresses (the UDP connect sends no packet)."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except OSError:
        pass
    return found or ["127.0.0.1"]


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="helios_web", description="Control de shows láser Helios desde el celular"
    )
    p.add_argument(
        "--host", default="0.0.0.0", help="interfaz de red (por defecto todas)"
    )
    p.add_argument(
        "--port", type=int, default=8080, help="puerto web (por defecto 8080)"
    )
    p.add_argument(
        "--simulate", action="store_true", help="usar el simulador aunque haya un DAC"
    )
    p.add_argument("--lib", help="ruta a la librería del DAC (HeliosDacAPI)")
    p.add_argument("--data", default=DEFAULT_DATA, help="carpeta para ajustes y cues")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    engine = Engine(create_output(args.simulate, args.lib), Store(args.data))
    engine.start()
    app = create_app(engine)

    async def stop_engine(app):
        await asyncio.get_running_loop().run_in_executor(None, engine.shutdown)

    app.on_cleanup.append(stop_engine)
    hosts = lan_addresses() if args.host in ("0.0.0.0", "") else [args.host]
    mode = (
        "SIMULADOR (sin láser)"
        if engine.output.simulated
        else ", ".join(d.name for d in engine.dacs)
    )
    print("\n  Helios Web Control")
    print(f"  Salida: {mode}")
    for host in hosts:
        print(f"  Abre en tu celular:  http://{host}:{args.port}")
    print("  La salida del láser arranca APAGADA. Ctrl+C para salir.\n", flush=True)
    try:
        web.run_app(app, host=args.host, port=args.port, print=None)
    finally:
        engine.shutdown()


if __name__ == "__main__":
    main()
