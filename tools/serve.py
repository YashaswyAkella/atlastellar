#!/usr/bin/env python3
"""Development server: like `python3 -m http.server`, but tells the browser never to cache.

Plain http.server sends no cache headers, so browsers guess, and an ES module or worker script edited a
minute ago can keep being served from cache. Run from anywhere:  python3 tools/serve.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):  # keep the terminal quiet
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    print(f"Atlastellar on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT))).serve_forever()
