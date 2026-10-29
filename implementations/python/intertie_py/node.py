"""Home and peer roles over one sqlite store (core.md §5-§7, capabilities threads/reactions)."""
import json, random, re, secrets, sqlite3, sys, threading, time, uuid
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

from . import net, sig
from .sig import ProtoError

MAX_BODY = 1 << 20
EVENT_ID = re.compile(r"[A-Za-z0-9_-]{16,64}")
SCOPED = re.compile(r"[A-Za-z0-9._-]{1,128}@[^@\s]{1,253}")
TS = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)")
HOME_ONLY = {"peer.join", "channel.update", "channel.close"}
NEEDS_SENDER = {"message.create", "message.edit", "reaction.add", "reaction.remove"}
DEAD_AFTER = 72 * 3600

SCHEMA = """
create table if not exists meta(k text primary key, v text);
create table if not exists channels(id text primary key, home text, name text, topic text,
  seq integer default 0, closed integer default 0, active integer default 1, endpoint text);
create table if not exists peers(channel text, org text, display_name text, delivery text,
  join_seq integer, leave_seq integer, delivered integer, last_ok real, primary key(channel, org));
create table if not exists events(channel text, seq integer, id text, origin text, type text,
  target text, json text, primary key(channel, seq));
create index if not exists events_id on events(channel, id);
create table if not exists held(channel text, seq integer, json text, primary key(channel, seq));
create table if not exists invites(token text primary key, channel text, org text, expires real, used_by text);
create table if not exists submissions(id text primary key, channel text, status text, seq integer);
"""


def now_ts():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def backoff(attempt, retry_after=None):
    d = min(300.0, 2.0 ** attempt) * random.uniform(0.75, 1.0)
    try:
        return max(d, min(float(retry_after), 300.0)) if retry_after else d
    except ValueError:
        return d


def _str(v, lo=0):
    return isinstance(v, str) and len(v) >= lo


def _id(v):
    return isinstance(v, str) and bool(EVENT_ID.fullmatch(v))


BODY_OK = {  # Core + capability body rules the home enforces (core.md §5, capabilities.md)
    "message.create": lambda b: _str(b.get("text")) and bool(b["text"] or b.get("files"))
    and ("thread" not in b or _id(b["thread"])),
    "message.edit": lambda b: _id(b.get("target")) and _str(b.get("text"), 1),
    "message.delete": lambda b: _id(b.get("target")),
    "reaction.add": lambda b: _id(b.get("target")) and _str(b.get("emoji"), 1) and len(b["emoji"].encode()) <= 32,
    "peer.join": lambda b: _str(b.get("org")),
    "peer.leave": lambda b: _str(b.get("org")) and b.get("reason") in ("left", "removed", "unreachable", "closed"),
    "channel.update": lambda b: all(_str(b[k]) for k in ("name", "topic") if k in b) and b.get("name") != "",
}
BODY_OK["reaction.remove"] = BODY_OK["reaction.add"]


def shape_error(ev, delivered: bool):
    """Envelope and body checks -> "invalid_event" or None. Unknown types: envelope only."""
    if not isinstance(ev, dict) or delivered != ("seq" in ev):
        return "invalid_event"
    if delivered and (type(ev["seq"]) is not int or ev["seq"] < 1):
        return "invalid_event"
    if not (_id(ev.get("id")) and _str(ev.get("channel")) and SCOPED.fullmatch(ev["channel"])
            and _str(ev.get("type"), 1) and len(ev["type"]) <= 128 and isinstance(ev.get("body"), dict)):
        return "invalid_event"
    if delivered:  # trust the home for the rest; ignore what we don't understand
        return None
    snd, t = ev.get("sender"), ev["type"]
    if not (_str(ev.get("origin"), 1) and _str(ev.get("ts")) and TS.fullmatch(ev["ts"])):
        return "invalid_event"
    if snd is not None and not (isinstance(snd, dict) and _str(snd.get("id")) and SCOPED.fullmatch(snd["id"])
                                and _str(snd.get("name"), 1)
                                and (snd.get("avatar") is None or str(snd["avatar"]).startswith("https://"))):
        return "invalid_event"
    if (t in NEEDS_SENDER and snd is None) or not BODY_OK.get(t, lambda b: True)(ev["body"]):
        return "invalid_event"
    return None


def too_large(ev) -> bool:
    b, name = ev["body"], (ev.get("sender") or {}).get("name", "")
    return (len(b.get("text", "") if isinstance(b.get("text"), str) else "") > 16000 or len(name) > 80
            or len((ev.get("sender") or {}).get("avatar") or "") > 2048
            or any(isinstance(b.get(k), str) and len(b[k]) > n for t, k, n in (
                ("peer.join", "display_name", 80), ("channel.update", "name", 80), ("channel.update", "topic", 250))
                   if ev["type"] == t))


class Node:
    def __init__(self, org, endpoint, db=":memory:", dev=False, display_name=None, delivery="push"):
        self.org, self.endpoint, self.dev = org, endpoint.rstrip("/"), dev
        u = urlsplit(self.endpoint)
        self.origin, self.prefix = f"{u.scheme}://{u.netloc}", u.path
        self.display_name, self.delivery = display_name or org, delivery
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.db = sqlite3.connect(db, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.execute("insert or ignore into meta values('seed', ?)", (secrets.token_hex(32),))
        seed = self.q1("select v from meta where k='seed'")
        self.key, self.kid = sig.private_key(bytes.fromhex(seed["v"])), "k1"
        self.dir = net.Directory(dev)
        self.nonces, self.buckets, self.workers, self.pulling = {}, {}, set(), {}

    def q(self, sql, *a):
        return self.db.execute(sql, a).fetchall()

    def q1(self, sql, *a):
        return self.db.execute(sql, a).fetchone()

    def discovery(self):
        return {"intertie": "0.1", "org": self.org, "display_name": self.display_name,
                "endpoint": self.endpoint, "delivery": self.delivery,
                "keys": [{"kty": "OKP", "crv": "Ed25519", "kid": self.kid, "x": sig.public_x(self.key)}],
                "capabilities": ["threads", "reactions"], "limits": {"max_body_bytes": MAX_BODY}}

    # ---- signed requests -------------------------------------------------------------
    def call(self, url, method="GET", obj=None, timeout=30.0):
        body = json.dumps(obj, separators=(",", ":")).encode() if obj is not None else None
        h = sig.sign_headers(self.key, f"{self.org}#{self.kid}", method, url, body)
        h["Host"] = urlsplit(url).netloc
        if body:
            h["Content-Type"] = "application/json"
        status, hdrs, data = net.request(url, method, body, h, self.dev, timeout)
        try:
            return status, hdrs, json.loads(data) if data else None
        except ValueError:
            return status, hdrs, None

    def authenticate(self, method, target, headers, body) -> str:
        """core.md §4 verification, in order. Returns the authenticated org."""
        p = sig.parse(headers.get_all("Signature-Input"), headers.get_all("Signature"), bool(body))
        now = time.time()
        if abs(now - p["created"]) > 300:
            raise ProtoError(401, "stale_signature", "created outside +-300 s")
        with self.lock:
            if len(self.nonces) > 10000 or random.random() < 0.01:
                self.nonces = {k: t for k, t in self.nonces.items() if t > now - 600}
            if self.nonces.get((p["keyid"], p["nonce"]), 0) > now - 600:
                raise ProtoError(401, "replayed", "nonce already seen")
            self.nonces[(p["keyid"], p["nonce"])] = now
        org, _, kid = p["keyid"].rpartition("#")
        try:
            pub = self.dir.key(org, kid) if org and kid else None
        except net.FetchError as e:
            raise ProtoError(401, "unknown_key", str(e))
        if pub is None:
            raise ProtoError(401, "unknown_key", f"no key {p['keyid']}")
        digest = sig.content_digest(body) if body else None
        if body and headers.get_all("Content-Digest") != [digest]:
            raise ProtoError(401, "bad_digest", "Content-Digest does not match body")
        if not sig.verify(pub, p["sig"], sig.signature_base(method, self.origin + target, p["params"], digest)):
            raise ProtoError(401, "bad_signature", "signature does not verify")
        return org

    def rate_limit(self, org, rate=50.0, burst=500.0):
        with self.lock:
            tokens, t = self.buckets.get(org, (burst, time.time()))
            tokens = min(burst, tokens + (time.time() - t) * rate)
            if tokens < 1:
                raise ProtoError(429, "rate_limited", "slow down")
            self.buckets[org] = (tokens - 1, time.time())

    # ---- home: channels, invites, accept ---------------------------------------------
    def channel(self, cid):
        return self.q1("select * from channels where id=?", cid)

    def homed(self, cid):
        return self.q1("select * from channels where id=? and home=?", cid, self.org)

    def peer(self, cid, org):
        return self.q1("select * from peers where channel=? and org=?", cid, org)

    def channel_obj(self, ch, seq):
        peers = self.q("select org, display_name from peers where channel=? and leave_seq is null", ch["id"])
        return {"id": ch["id"], "name": ch["name"], "topic": ch["topic"], "home": ch["home"],
                "peers": [dict(p) for p in peers], "seq": seq}

    def create_channel(self, name, topic=""):
        if not 1 <= len(name) <= 80 or len(topic) > 250:
            raise ValueError("name 1-80 chars, topic <= 250")
        cid = f"c-{secrets.token_hex(6)}@{self.org}"
        with self.lock:
            self.db.execute("insert into channels(id, home, name, topic) values(?,?,?,?)",
                            (cid, self.org, name, topic))
            log("audit channel.create", cid)
            return self.channel_obj(self.channel(cid), 0)

    def create_invite(self, cid, org=None, ttl=7 * 86400):
        with self.lock:
            if not self.homed(cid):
                raise ValueError("not a channel this org homes")
            token = sig.b64u(secrets.token_bytes(16))
            self.db.execute("insert into invites values(?,?,?,?,null)", (token, cid, org, time.time() + ttl))
            log("audit invite.create", cid, "bound to", org)
            return f"intertie:{self.org}/{token}"

    def handle_accept(self, auth, body):
        token, delivery = body.get("token"), body.get("delivery")
        if not isinstance(token, str):
            raise ProtoError(400, "bad_request", "token required")
        doc = self.dir.resolve(auth)  # cached: authenticate() just resolved it
        if delivery not in ("push", "pull"):
            delivery = doc.get("delivery", "push")
        name = doc.get("display_name") if isinstance(doc.get("display_name"), str) else auth
        with self.lock:
            inv = self.q1("select * from invites where token=?", token)
            ch = inv and self.homed(inv["channel"])
            p = ch and self.peer(ch["id"], auth)
            if p and p["leave_seq"] is None:  # repeat accept from an active peer
                return {"channel": self.channel_obj(ch, p["join_seq"] - 1)}
            if (not ch or inv["used_by"] or inv["expires"] < time.time() or (inv["org"] and inv["org"] != auth)
                    or auth == self.org or ch["closed"]):
                raise ProtoError(404, "invalid_invite", "invalid, expired or used invite")
            self.db.execute("update invites set used_by=? where token=?", (auth, token))
            self.db.execute("insert or replace into peers values(?,?,?,?,?,null,?,?)",
                            (ch["id"], auth, name[:80], delivery, ch["seq"] + 1, ch["seq"], time.time()))
            resp = {"channel": self.channel_obj(ch, ch["seq"])}
            self.sequence(self.envelope(ch["id"], "peer.join", {"org": auth, "display_name": name[:80]}))
            log("audit invite.accepted", ch["id"], "by", auth, "delivery", delivery)
            return resp

    # ---- home: sequencing --------------------------------------------------------------
    def envelope(self, cid, type_, body, sender=None):
        ev = {"id": str(uuid.uuid4()), "type": type_, "channel": cid, "origin": self.org,
              "ts": now_ts(), "body": body}
        if sender:
            ev["sender"] = sender
        return ev

    def find(self, cid, eid):
        r = self.q1("select * from events where channel=? and id=?", cid, eid)
        return r and json.loads(r["json"])

    def check_submission(self, auth, ev):
        """core.md §7.1 checks 1-6 (+ threads). Returns (code, seq) or None."""
        code = shape_error(ev, delivered=False)
        if code:
            return code, None
        ch, local, t, b = self.homed(ev["channel"]), auth == self.org, ev["type"], ev["body"]
        if not ch:  # a channel we are a peer of: only its home may send, and with a seq
            return ("not_home" if self.channel(ev["channel"]) else "unknown_channel"), None
        if not local:
            p = self.peer(ch["id"], auth)
            if not p or p["leave_seq"] is not None:
                return "not_participant", None
        if ch["closed"]:
            return "channel_closed", None
        if ev["origin"] != auth or (ev.get("sender") and not ev["sender"]["id"].endswith("@" + auth)):
            return "bad_origin", None
        if (t in HOME_ONLY or (t == "peer.leave" and b["org"] != auth)) and not local:
            return "not_author", None
        if t in ("message.edit", "message.delete"):
            tgt = self.find(ch["id"], b["target"])
            if not tgt or tgt["type"] != "message.create":
                if not local:
                    return "not_author", None
            elif tgt["origin"] != ev["origin"] and not (local and t == "message.delete"):
                return "not_author", None
            elif t == "message.edit" and (tgt.get("sender") or {}).get("id") != ev["sender"]["id"]:
                return "not_author", None
        dup = self.q1("select * from events where channel=? and id=?", ch["id"], ev["id"])
        if dup:
            return ("duplicate", dup["seq"]) if dup["origin"] == ev["origin"] else ("id_conflict", None)
        if too_large(ev):
            return "too_large", None
        if t == "message.create" and "thread" in b:
            root = self.find(ch["id"], b["thread"])
            if not root or root["type"] != "message.create" or "thread" in root["body"]:
                return "invalid_event", None
        return None

    def sequence(self, ev):
        """Assign the next seq, store, apply side effects, wake pullers and pushers. Hold the lock."""
        cid = ev["channel"]
        seq = self.channel(cid)["seq"] + 1
        ev = dict(ev, seq=seq)
        self.store(ev)
        b = ev["body"]
        if ev["type"] == "peer.leave":
            self.db.execute("update peers set leave_seq=? where channel=? and org=? and leave_seq is null",
                            (seq, cid, b["org"]))
            log("audit peer.leave", cid, b["org"], b["reason"])
        elif ev["type"] == "channel.close":
            self.db.execute("update channels set closed=1 where id=?", (cid,))
            log("audit channel.close", cid)
        self.cond.notify_all()
        self.kick(cid)
        return seq

    def store(self, ev):
        """Append to the local log (both roles) and apply edits of channel state / purges."""
        cid, b, t = ev["channel"], ev["body"], ev["type"]
        self.db.execute("insert or ignore into events values(?,?,?,?,?,?,?)",
                        (cid, ev["seq"], ev["id"], ev.get("origin"), t,
                         b.get("target") if isinstance(b.get("target"), str) else None, json.dumps(ev)))
        self.db.execute("update channels set seq=? where id=?", (ev["seq"], cid))
        if t == "channel.update":
            for k in ("name", "topic"):
                if isinstance(b.get(k), str):
                    self.db.execute(f"update channels set {k}=? where id=?", (b[k], cid))
        if t == "message.delete":  # purge: keep the shell (core.md §5)
            tgt = self.find(cid, b.get("target"))
            if tgt and tgt["type"] == "message.create" and (
                    tgt.get("origin") == ev.get("origin") or ev.get("origin") == self.channel(cid)["home"]):
                tgt["body"] = {"text": "", "deleted": True, **({"thread": tgt["body"]["thread"]}
                                                               if "thread" in tgt["body"] else {})}
                self.db.execute("update events set json=? where channel=? and id=?",
                                (json.dumps(tgt), cid, tgt["id"]))
                for r in self.q("select seq, json from events where channel=? and type='message.edit' and target=?",
                                cid, tgt["id"]):
                    e = json.loads(r["json"])
                    e["body"]["text"] = ""
                    self.db.execute("update events set json=? where channel=? and seq=?", (json.dumps(e), cid, r["seq"]))

    def handle_events(self, auth, body):
        evs = body.get("events") if isinstance(body, dict) else None
        if not isinstance(evs, list) or not 1 <= len(evs) <= 100:
            raise ProtoError(400, "bad_request", "events must be an array of 1-100")
        results = []
        with self.lock:
            for ev in evs:
                eid = ev.get("id") if isinstance(ev, dict) else None
                if isinstance(ev, dict) and "seq" in ev and not self.homed(ev.get("channel")):
                    code, seq = self.ingest_delivery(auth, ev)
                else:
                    r = self.check_submission(auth, ev)
                    code, seq = r if r else ("accepted", self.sequence(ev))
                if code in ("accepted", "duplicate"):
                    results.append({"id": eid, "status": code, "seq": seq})
                else:
                    results.append({"id": eid, "status": "rejected", "error": {"code": code, "message": code}})
                    log("audit rejected", auth, code, eid)
        return {"results": results}

    def handle_pull(self, auth, cid, query):
        try:
            since, limit, wait = int(query.get("since", 0)), int(query.get("limit", 100)), int(query.get("wait", 0))
        except ValueError:
            raise ProtoError(400, "bad_request", "since/limit/wait must be integers")
        if since < 0 or not 1 <= limit <= 100 or not 0 <= wait <= 30:
            raise ProtoError(400, "bad_request", "since >= 0, limit 1-100, wait 0-30")
        deadline = time.time() + wait
        with self.cond:
            if not SCOPED.fullmatch(cid) or not self.homed(cid):
                raise ProtoError(404, "unknown_channel", "no such channel")
            while True:
                p = self.peer(cid, auth)
                if not p:
                    raise ProtoError(403, "not_participant", "not a participant of this channel")
                hi = p["leave_seq"] if p["leave_seq"] is not None else 1 << 62
                rows = self.q("select json from events where channel=? and seq>? and seq<=? order by seq limit ?",
                              cid, max(since, p["join_seq"] - 1), hi, limit)
                left = deadline - time.time()
                if rows or left <= 0 or since >= hi:
                    return {"events": [json.loads(r["json"]) for r in rows], "seq": self.homed(cid)["seq"]}
                self.cond.wait(left)

    # ---- home: fan-out ---------------------------------------------------------------
    def kick(self, cid):
        for p in self.q("select org from peers where channel=? and delivery='push'", cid):
            k = (cid, p["org"])
            if k not in self.workers:
                self.workers.add(k)
                threading.Thread(target=self.deliver_loop, args=k, daemon=True).start()

    def deliver_loop(self, cid, org):
        attempt = 0
        while True:
            with self.lock:
                p, ch = self.peer(cid, org), self.homed(cid)
                hi = p["leave_seq"] if p["leave_seq"] is not None else ch["seq"]
                dead = time.time() - p["last_ok"] > DEAD_AFTER
                if p["delivery"] != "push" or p["delivered"] >= hi or dead:
                    self.workers.discard((cid, org))
                    if dead:
                        log("peer dead, stopped pushing", cid, org)
                    return
                rows = self.q("select json from events where channel=? and seq>? and seq<=? order by seq limit 100",
                              cid, p["delivered"], hi)
            batch, size = [], 0
            for r in rows:  # keep each push under the receiver's body limit
                size += len(r["json"]) + 1
                if batch and size > MAX_BODY - 4096:
                    break
                batch.append(json.loads(r["json"]))
            hdrs = {}
            try:
                status, hdrs, _ = self.call(self.dir.resolve(org)["endpoint"] + "/events", "POST", {"events": batch})
            except net.FetchError as e:
                status = str(e)
            if status == 200:
                with self.lock:
                    self.db.execute("update peers set delivered=max(delivered, ?), last_ok=? where channel=? and org=?",
                                    (batch[-1]["seq"], time.time(), cid, org))
                attempt = 0
            else:  # home->peer: every failure is retried (core.md §7.2)
                log("push failed", org, status)
                time.sleep(backoff(attempt, hdrs.get("retry-after")))
                attempt += 1

    # ---- peer role ---------------------------------------------------------------------
    def accept_invite(self, invite):
        m = re.fullmatch(r"intertie:([^/\s]+)/([A-Za-z0-9_-]{16,})", invite.strip())
        if not m or not net.valid_org(m[1], self.dev):
            raise ValueError("invite must look like intertie:<org>/<token>")
        home, token = m[1], m[2]
        ep = self.dir.resolve(home)["endpoint"]
        status, _, j = self.call(ep + "/accept", "POST", {"token": token, "delivery": self.delivery})
        c = (j or {}).get("channel") if status == 200 else None
        if (not isinstance(c, dict) or c.get("home") != home or not isinstance(c.get("id"), str)
                or not c["id"].endswith("@" + home) or type(c.get("seq")) is not int):
            raise ValueError(f"accept failed: HTTP {status} {j}")
        with self.lock:
            old = self.channel(c["id"])
            self.db.execute("insert or replace into channels values(?,?,?,?,?,0,1,?)",
                            (c["id"], home, c.get("name"), c.get("topic"), max(c["seq"], old["seq"] if old else 0), ep))
            self.db.execute("delete from held where channel=? and seq<=?", (c["id"], c["seq"]))
        log("audit joined", c["id"], "delivery", self.delivery)
        self.catch_up(c["id"])
        if self.delivery == "pull":
            threading.Thread(target=self.poll_loop, args=(c["id"],), daemon=True).start()
        return c

    def ingest_delivery(self, auth, ev):
        """A pushed or pulled event with a seq (core.md §7.1 'At a peer'). Hold the lock."""
        if shape_error(ev, delivered=True):
            return "invalid_event", None
        ch = self.channel(ev["channel"])
        if not ch:
            return "unknown_channel", None
        if ch["home"] == self.org or auth != ch["home"]:
            return "not_home", None
        seq = ev["seq"]
        if seq <= ch["seq"]:
            return "duplicate", seq
        if seq > ch["seq"] + 1:  # gap: hold it, repair by pull
            self.db.execute("insert or ignore into held values(?,?,?)", (ch["id"], seq, json.dumps(ev)))
            threading.Thread(target=self.catch_up, args=(ch["id"],), daemon=True).start()
            return "accepted", seq
        self.apply(ev)
        while True:
            nxt = self.q1("select json from held where channel=? and seq=?", ch["id"], self.channel(ch["id"])["seq"] + 1)
            if not nxt:
                break
            self.apply(json.loads(nxt["json"]))
        self.db.execute("delete from held where channel=? and seq<=?", (ch["id"], self.channel(ch["id"])["seq"]))
        return "accepted", seq

    def apply(self, ev):
        cid, b = ev["channel"], ev["body"]
        self.store(ev)
        if ev.get("origin") == self.org:
            if not self.q1("select 1 from submissions where id=?", ev["id"]):
                log("ALERT: home relayed an event with our origin that we never submitted:", ev["id"])
            self.db.execute("update submissions set status='sequenced', seq=? where id=?", (ev["seq"], ev["id"]))
        if (ev["type"] == "peer.leave" and b.get("org") == self.org) or ev["type"] == "channel.close":
            self.db.execute("update channels set active=0, closed=? where id=?",
                            (1 if ev["type"] == "channel.close" else 0, cid))
            log("audit channel inactive", cid, ev["type"])
        self.cond.notify_all()

    def pull_once(self, cid, wait=0):
        ch = self.channel(cid)
        url = f"{ch['endpoint']}/channels/{quote(cid, safe='')}/events?since={ch['seq']}&limit=100&wait={wait}"
        status, _, j = self.call(url, timeout=wait + 30.0)
        if status != 200 or not isinstance(j, dict) or not isinstance(j.get("events"), list):
            raise net.FetchError(f"pull: HTTP {status}")
        with self.lock:
            for ev in j["events"]:
                self.ingest_delivery(ch["home"], ev)
            ch = self.channel(cid)
            held = self.q1("select max(seq) m from held where channel=?", cid)["m"]
        return ch["seq"] >= max(j.get("seq") or 0, held or 0) or not j["events"]

    def catch_up(self, cid):
        """Pull until caught up. One puller per channel; a request during a run makes it go again."""
        with self.lock:
            if self.pulling.get(cid) is not None:
                self.pulling[cid] = True
                return
            self.pulling[cid] = False
        attempt = 0
        while attempt < 12:
            try:
                done = self.pull_once(cid)
            except (net.FetchError, OSError) as e:
                log("pull failed", cid, e)
                time.sleep(backoff(attempt))
                attempt, done = attempt + 1, False
            with self.lock:
                if done and not self.pulling[cid]:
                    break
                self.pulling[cid] = False if done else self.pulling[cid]
        with self.lock:
            self.pulling.pop(cid, None)

    def poll_loop(self, cid, attempt=0):
        while self.channel(cid)["active"]:
            try:
                self.pull_once(cid, wait=25)
                attempt = 0
            except (net.FetchError, OSError):
                time.sleep(backoff(attempt))
                attempt += 1

    # ---- local users (admin surface) ----------------------------------------------------
    def post(self, cid, type_, body, sender=None):
        """Create an event as this org: sequenced here if we home it, else submitted."""
        ev = self.envelope(cid, type_, body, sender)
        with self.lock:
            ch = self.channel(cid)
            if not ch:
                raise ValueError("unknown channel")
            if ch["home"] == self.org:
                r = self.check_submission(self.org, ev)
                if r:
                    return {"id": ev["id"], "status": "rejected", "error": {"code": r[0]}}
                return {"id": ev["id"], "status": "accepted", "seq": self.sequence(ev)}
            if not ch["active"]:
                raise ValueError("channel is no longer active here")
            self.db.execute("insert into submissions values(?,?,'sending',null)", (ev["id"], cid))
        return self.submit(ch["endpoint"], ev)

    def submit(self, endpoint, ev, background=False, attempt=0):
        while True:
            hdrs, j = {}, None
            try:
                status, hdrs, j = self.call(endpoint + "/events", "POST", {"events": [ev]})
            except net.FetchError:
                status = None
            if status == 200 and isinstance(j, dict) and j.get("results"):
                r = j["results"][0]
                with self.lock:
                    if r.get("status") == "rejected":
                        self.db.execute("update submissions set status='rejected' where id=?", (ev["id"],))
                    elif not self.q1("select seq from submissions where id=?", ev["id"])["seq"]:
                        self.db.execute("update submissions set status=?, seq=? where id=?",
                                        (r.get("status"), r.get("seq"), ev["id"]))
                return r
            if status is not None and 400 <= status < 500 and status not in (408, 429):
                with self.lock:
                    self.db.execute("update submissions set status='failed' where id=?", (ev["id"],))
                return {"id": ev["id"], "status": "failed", "http": status, "error": (j or {}).get("error")}
            if not background:
                threading.Thread(target=self.submit, args=(endpoint, ev, True), daemon=True).start()
                return {"id": ev["id"], "status": "sending"}
            time.sleep(backoff(attempt, hdrs.get("retry-after")))
            attempt += 1
