"""Receive SC Orgs webhooks with the standard library's HTTP server and check their signatures.

    SCO_WEBHOOK_SECRET=whsec_... python3 examples/webhook_server.py

For production, put the same three lines (read the raw body, construct_event, answer 2xx)
in your web framework's handler.
"""

import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from sc_orgs_sdk import WebhookVerificationError, construct_event

SECRET = os.environ["SCO_WEBHOOK_SECRET"]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))  # the raw bytes
        try:
            event = construct_event(SECRET, self.headers, body)
        except WebhookVerificationError as e:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        print(event["type"], event["organization"]["sid"], event["data"])
        self.send_response(200)
        self.end_headers()


# Loopback by default: put a TLS reverse proxy in front rather than exposing this port directly.
HTTPServer((os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "3000"))), Handler).serve_forever()
