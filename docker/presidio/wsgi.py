"""Presidio analyzer REST server + the Brazilian recognizers of tarja-presidio.

Presidio's image builds the engine from YAML, which cannot load external recognizer classes, so
this wrapper reuses its own Server (same /analyze and /health) and registers tarja's afterwards.
"""

import tarja_presidio
from app import Server

_server = Server()
tarja_presidio.register(_server.engine.registry, supported_language="pt")

app = _server.app
