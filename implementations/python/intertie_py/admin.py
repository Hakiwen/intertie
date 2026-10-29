"""Admin surface (not part of the protocol): loopback + bearer token JSON API, and a UI view."""
import hmac, ipaddress, json, re
from urllib.parse import unquote

from . import net
from .sig import ProtoError


def handle(self, method, path, body):
    if not ipaddress.ip_address(self.client_address[0]).is_loopback or not hmac.compare_digest(
            self.headers.get("Authorization", ""), f"Bearer {self.admin_token}"):
        raise ProtoError(401, "unauthorized", "admin API needs loopback + bearer token")
    n, a = self.node, json.loads(body or b"{}")
    try:
        if method == "GET" and path == "/channels":
            return self.reply(200, {"channels": [dict(r) for r in n.q("select * from channels")]})
        m = re.fullmatch(r"/channels/([^/]+)", path)
        if method == "GET" and m:
            cid = unquote(m[1])
            ch = n.channel(cid)
            if not ch:
                raise ValueError("unknown channel")
            with n.lock:
                evs = [json.loads(r["json"]) for r in n.q("select json from events where channel=? order by seq", cid)]
                peers = [dict(r) for r in n.q("select * from peers where channel=?", cid)]
                return self.reply(200, {"channel": dict(ch), "peers": peers, "messages": view(n, cid), "events": evs})
        if method != "POST":
            raise ValueError("unknown admin route")
        if path == "/channels":
            return self.reply(200, {"channel": n.create_channel(a["name"], a.get("topic", ""))})
        if path == "/invites":
            return self.reply(200, {"invite": n.create_invite(a["channel"], a.get("org"), a.get("ttl", 7 * 86400))})
        if path == "/accept":
            return self.reply(200, {"channel": n.accept_invite(a["invite"])})
        if path == "/post":
            body = a.get("body") or {}
            if "text" in a:
                body = {"text": a["text"], **({"thread": a["thread"]} if a.get("thread") else {})}
            t = a.get("type", "message.create")
            sender = None if t.startswith(("peer.", "channel.")) else {
                "id": f"{a.get('user', 'admin')}@{n.org}", "name": a.get("name", "Admin")}
            return self.reply(200, n.post(a["channel"], t, body, sender))
        raise ValueError("unknown admin route")
    except (ValueError, KeyError, net.FetchError) as e:
        self.reply(400, {"error": {"code": "bad_request", "message": f"{type(e).__name__}: {e}"}})


def view(n, cid):
    """Replay the local log into what a UI would display."""
    msgs, home = {}, n.channel(cid)["home"]
    for r in n.q("select json from events where channel=? order by seq", cid):
        ev = json.loads(r["json"])
        t, b = ev["type"], ev["body"]
        m = msgs.get(b["target"]) if isinstance(b.get("target"), str) else None
        if t == "message.create":
            msgs[ev["id"]] = {"id": ev["id"], "seq": ev["seq"], "sender": ev.get("sender"),
                              "origin": ev.get("origin"), "text": b.get("text", ""), "thread": b.get("thread"),
                              "deleted": bool(b.get("deleted")), "reactions": []}
        elif t == "message.edit" and m and not m["deleted"] and m["origin"] == ev["origin"] \
                and (m["sender"] or {}).get("id") == (ev.get("sender") or {}).get("id"):
            m["text"] = b.get("text", "")
        elif t == "message.delete" and m and ev.get("origin") in (m["origin"], home):
            m["text"], m["deleted"] = "", True
        elif t in ("reaction.add", "reaction.remove") and m:
            trip = [(ev.get("sender") or {}).get("id"), b.get("emoji")]
            if t == "reaction.add" and trip not in m["reactions"]:
                m["reactions"].append(trip)
            elif t == "reaction.remove" and trip in m["reactions"]:
                m["reactions"].remove(trip)
    return list(msgs.values())
