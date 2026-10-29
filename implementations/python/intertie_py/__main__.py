"""CLI: `serve` runs a node; `admin ...` drives a running node's admin API."""
import argparse, json, os, secrets, sys, urllib.request
from urllib.parse import quote

from . import node as nodemod, server


def serve(a):
    if not a.dev_insecure and not (a.org and a.endpoint and a.endpoint.startswith("https://")):
        sys.exit("outside --dev-insecure, --org and an https --endpoint are required")
    org = a.org or f"localhost:{a.port}"
    endpoint = a.endpoint or f"http://{org}/intertie"
    n = nodemod.Node(org, endpoint, a.db, a.dev_insecure, a.display_name, a.delivery)
    given = a.admin_token or os.environ.get("INTERTIE_ADMIN_TOKEN")
    token = given or secrets.token_urlsafe(18)
    srv = server.serve(n, a.host, a.port, token)
    # Never echo a token the operator supplied; a generated one must be shown once to be usable.
    shown = "(as configured)" if given else token
    print(f"intertie-py: org={org} endpoint={endpoint} admin-token={shown}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def admin(a):
    base = a.url or f"http://127.0.0.1:{a.port}"
    token = a.token or os.environ.get("INTERTIE_ADMIN_TOKEN", "")
    c = a.cmd
    if c == "channels":
        req = ("GET", "/admin/channels", None)
    elif c == "show":
        req = ("GET", "/admin/channels/" + quote(a.args[0], safe=""), None)
    elif c == "create-channel":
        req = ("POST", "/admin/channels", {"name": a.args[0], "topic": a.args[1] if len(a.args) > 1 else ""})
    elif c == "invite":
        req = ("POST", "/admin/invites", {"channel": a.args[0], **({"org": a.args[1]} if len(a.args) > 1 else {})})
    elif c == "accept":
        req = ("POST", "/admin/accept", {"invite": a.args[0]})
    elif c == "post":
        req = ("POST", "/admin/post", {"channel": a.args[0], "text": a.args[1], "user": a.user, "name": a.name,
                                        **({"thread": a.thread} if a.thread else {})})
    elif c == "event":
        req = ("POST", "/admin/post", {"channel": a.args[0], "type": a.args[1], "body": json.loads(a.args[2]),
                                        "user": a.user, "name": a.name})
    else:
        sys.exit(f"unknown admin command {c}")
    method, path, body = req
    r = urllib.request.Request(base + path, method=method, headers={"Authorization": f"Bearer {token}"},
                               data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(r) as resp:
            print(resp.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(e.read().decode())


def main():
    p = argparse.ArgumentParser(prog="intertie_py")
    sub = p.add_subparsers(dest="mode", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=9484)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--org")
    s.add_argument("--endpoint")
    s.add_argument("--display-name")
    s.add_argument("--db", default=":memory:")
    s.add_argument("--delivery", choices=["push", "pull"], default="push")
    s.add_argument("--admin-token")
    s.add_argument("--dev-insecure", action="store_true")
    d = sub.add_parser("admin")
    d.add_argument("--port", type=int, default=9484)
    d.add_argument("--url")
    d.add_argument("--token")
    d.add_argument("--user", default="admin")
    d.add_argument("--name", default="Admin")
    d.add_argument("--thread")
    d.add_argument("cmd")
    d.add_argument("args", nargs="*")
    a = p.parse_args()
    serve(a) if a.mode == "serve" else admin(a)


if __name__ == "__main__":
    main()
