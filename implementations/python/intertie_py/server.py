"""HTTP surface: discovery and the three protocol paths (admin routes live in admin.py)."""
import json, re, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

from . import admin, node as nodemod
from .sig import ProtoError

PULL = re.compile(r"/channels/([^/]+)/events")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    node: nodemod.Node = None
    admin_token = ""

    def log_message(self, fmt, *args):
        pass

    def reply(self, status, obj, headers=None):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def read_body(self, limit):
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise ProtoError(400, "bad_request", "chunked bodies are not supported")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n < 0 or n > limit:
            self.close_connection = True
            raise ProtoError(413 if n > limit else 400, "too_large" if n > limit else "bad_request",
                             f"body over {limit} bytes" if n > limit else "bad Content-Length")
        self.body_read = True
        return self.rfile.read(n) if n else b""

    def route(self, method):
        n = self.node
        path, _, query = self.path.partition("?")
        self.body_read = False
        try:
            if path == "/.well-known/intertie":
                if method != "GET":
                    raise ProtoError(405, "bad_request", "GET only")
                return self.reply(200, n.discovery(), {"Cache-Control": "max-age=300"})
            if path.startswith("/admin/"):
                return admin.handle(self, method, path[len("/admin"):], self.read_body(nodemod.MAX_BODY))
            sub = path[len(n.prefix):] if path.startswith(n.prefix + "/") else None
            pull = PULL.fullmatch(sub or "")
            if sub not in ("/events", "/accept") and not pull:
                raise ProtoError(404, "bad_request", "no such path")
            if (method != "GET") if pull else (method != "POST"):
                raise ProtoError(405, "bad_request", "method not allowed")
            body = self.read_body(nodemod.MAX_BODY)
            auth = n.authenticate(method, self.path, self.headers, body)
            n.rate_limit(auth)
            if pull:
                q = {k: v[-1] for k, v in parse_qs(query, keep_blank_values=True).items()}
                return self.reply(200, n.handle_pull(auth, unquote(pull[1]), q))
            try:
                obj = json.loads(body)
            except ValueError:
                raise ProtoError(400, "bad_request", "body is not JSON")
            if not isinstance(obj, dict):
                raise ProtoError(400, "bad_request", "body must be an object")
            return self.reply(200, n.handle_accept(auth, obj) if sub == "/accept" else n.handle_events(auth, obj))
        except ProtoError as e:
            nodemod.log("http", e.status, e.code, method, path, e.message)
            self.close_connection = self.close_connection or not self.body_read
            self.reply(e.status, {"error": {"code": e.code, "message": e.message}},
                       {"Retry-After": "1"} if e.status == 429 else None)
        except Exception as e:
            traceback.print_exc()
            self.reply(500, {"error": {"code": "internal", "message": str(e)}})


def serve(node, host, port, admin_token):
    handler = type("BoundHandler", (Handler,), {"node": node, "admin_token": admin_token})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    return srv
