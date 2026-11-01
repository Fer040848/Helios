"""JSON persistence of settings and cues (the live scene and the armed flag are never stored)."""

import json
import logging
import os

log = logging.getLogger(__name__)


class Store:
    def __init__(self, directory):
        self.path = os.path.join(directory, "state.json")

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            log.warning("No se pudo leer %s; se usan valores por defecto", self.path)
            return {}
        return {k: data[k] for k in ("settings", "cues") if isinstance(data, dict) and k in data}

    def save(self, data):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"settings": data["settings"], "cues": data["cues"]}, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.path)
