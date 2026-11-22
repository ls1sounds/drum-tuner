"""Test helpers: a local web server for the app and a Playwright Chrome."""
import contextlib
import functools
import http.server
import os
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }

    def log_message(self, *args):
        pass


@contextlib.contextmanager
def serve(port=0):
    handler = functools.partial(QuietHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        # "localhost" counts as a secure origin, so the mic and service
        # worker are allowed without HTTPS.
        yield f"http://localhost:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()


@contextlib.contextmanager
def browser(args=None):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True, args=args or [])
        try:
            yield b
        finally:
            b.close()
