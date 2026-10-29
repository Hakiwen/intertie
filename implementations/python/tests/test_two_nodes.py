"""Two (and three) real nodes over loopback HTTP in dev mode: home, push peer, pull peer."""
import socket, threading, time, unittest

from intertie_py import admin, node as nodemod, server

nodemod.log = lambda *a: None  # keep test output quiet


def start(delivery="push"):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    org = f"localhost:{port}"
    n = nodemod.Node(org, f"http://{org}/intertie", dev=True, delivery=delivery)
    srv = server.serve(n, "127.0.0.1", port, "tok")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return n, srv


def until(pred, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    raise AssertionError("condition not reached")


def user(n, local="u-1", name="User"):
    return {"id": f"{local}@{n.org}", "name": name}


class TwoNodes(unittest.TestCase):
    def setUp(self):
        (self.home, self.hs), (self.peer, self.ps), (self.puller, self.pls) = start(), start(), start("pull")
        self.cid = self.home.create_channel("acme-globex")["id"]

    def tearDown(self):
        for s in (self.hs, self.ps, self.pls):
            s.shutdown()
            s.server_close()

    def seq_at(self, n):
        return n.channel(self.cid)["seq"]

    def texts(self, n):
        return {m["id"]: m["text"] for m in admin.view(n, self.cid)}

    def test_exchange(self):
        h, p, c = self.home, self.peer, self.puller
        ch = p.accept_invite(h.create_invite(self.cid, org=p.org))
        self.assertEqual((ch["seq"], ch["home"]), (0, h.org))
        until(lambda: self.seq_at(p) == 1)  # peer.join, pushed (or pulled after accept)
        with self.assertRaises(ValueError):  # invite bound to another org
            c.accept_invite(h.create_invite(self.cid, org="localhost:1"))
        c.accept_invite(h.create_invite(self.cid))
        until(lambda: self.seq_at(c) == 2)

        # peer submits; home sequences and pushes back to the origin too
        r = p.post(self.cid, "message.create", {"text": "hello"}, user(p, name="Gail"))
        self.assertEqual((r["status"], r["seq"]), ("accepted", 3))
        until(lambda: self.seq_at(p) == 3 and self.seq_at(c) == 3)
        mid = r["id"]
        # home user replies in thread; nested threads are rejected
        reply = h.post(self.cid, "message.create", {"text": "on it", "thread": mid}, user(h, name="Ana"))
        self.assertEqual(reply["status"], "accepted")
        bad = h.post(self.cid, "message.create", {"text": "x", "thread": reply["id"]}, user(h))
        self.assertEqual(bad["error"]["code"], "invalid_event")
        # edit own message; editing someone else's is refused at the home
        self.assertEqual(p.post(self.cid, "message.edit", {"target": mid, "text": "hello!"}, user(p))["status"],
                         "accepted")
        r = p.post(self.cid, "message.edit", {"target": mid, "text": "nope"}, user(p, "u-2"))
        self.assertEqual(r["error"]["code"], "not_author")  # same org, different sender
        r = p.post(self.cid, "message.edit", {"target": reply["id"], "text": "pwned"}, user(p))
        self.assertEqual(r["error"]["code"], "not_author")
        r = p.post(self.cid, "reaction.add", {"target": reply["id"], "emoji": "👀"}, user(p))
        self.assertEqual(r["status"], "accepted")
        until(lambda: self.seq_at(c) == h.channel(self.cid)["seq"])
        self.assertEqual((self.texts(c)[reply["id"]], self.texts(c)[mid]), ("on it", "hello!"))
        self.assertEqual(next(m for m in admin.view(c, self.cid) if m["id"] == reply["id"])["reactions"],
                         [[f"u-1@{p.org}", "👀"]])

        # home moderation delete: everyone stops showing it, home serves the shell
        h.post(self.cid, "message.delete", {"target": mid}, user(h))
        until(lambda: self.texts(p).get(mid) == "" and self.texts(c).get(mid) == "")
        self.assertEqual(h.find(self.cid, mid)["body"], {"text": "", "deleted": True})

        # peer leaves: it gets its own peer.leave, then nothing more
        p.post(self.cid, "peer.leave", {"org": p.org, "reason": "left"})
        until(lambda: not p.channel(self.cid)["active"])
        left_at = self.seq_at(p)
        h.post(self.cid, "message.create", {"text": "after leave"}, user(h))
        h.post(self.cid, "channel.close", {"reason": "done"})
        until(lambda: not c.channel(self.cid)["active"])
        time.sleep(0.3)
        self.assertEqual(self.seq_at(p), left_at)
        self.assertEqual(self.seq_at(c), h.channel(self.cid)["seq"])
        r = h.post(self.cid, "message.create", {"text": "closed?"}, user(h))
        self.assertEqual(r["error"]["code"], "channel_closed")

    def test_gap_is_repaired_by_pull(self):
        h, p = self.home, self.peer
        p.accept_invite(h.create_invite(self.cid))
        until(lambda: self.seq_at(p) == 1)
        with h.lock:  # pretend pushes 2..3 were lost: sequence without waking the pusher
            kick, h.kick = h.kick, lambda cid: None
            for i in range(2):
                h.sequence(h.envelope(self.cid, "message.create", {"text": f"m{i}"}, user(h)))
            h.kick = kick
            h.db.execute("update peers set delivered=3 where org=?", (p.org,))
        h.post(self.cid, "message.create", {"text": "m2"}, user(h))  # seq 4 pushed: gap at peer
        until(lambda: self.seq_at(p) == 4)
        self.assertEqual(sorted(self.texts(p).values()), ["m0", "m1", "m2"])


if __name__ == "__main__":
    unittest.main()
