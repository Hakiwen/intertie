import json, pathlib, unittest

from intertie_py import sig

VECTORS = json.loads((pathlib.Path(__file__).resolve().parents[3] / "spec/test-vectors/signature.json").read_text())


class SignatureVectors(unittest.TestCase):
    def setUp(self):
        k = VECTORS["key"]
        self.key = sig.private_key(bytes.fromhex(k["seed_hex"]))
        self.assertEqual(sig.private_key(sig.b64u_dec(k["d"])).sign(b"x"), self.key.sign(b"x"))
        self.assertEqual(sig.public_x(self.key), k["x"])

    def check(self, v, body):
        h = sig.sign_headers(self.key, v["keyid"], v["method"], v["url"], body, v["created"], v["nonce"])
        self.assertEqual(h["Signature-Input"], v["signature_input"])
        self.assertEqual(h["Signature"], v["signature"])
        p = sig.parse([h["Signature-Input"]], [h["Signature"]], bool(body))
        digest = sig.content_digest(body) if body else None
        base = sig.signature_base(v["method"], v["url"], p["params"], digest)
        self.assertEqual(base, v["signature_base"])
        self.assertTrue(sig.verify(sig.public_key(VECTORS["key"]["x"]), p["sig"], base))
        self.assertFalse(sig.verify(sig.public_key(VECTORS["key"]["x"]), p["sig"], base + "x"))
        return h

    def test_post(self):
        v = VECTORS["post"]
        h = self.check(v, v["body"].encode())
        self.assertEqual(h["Content-Digest"], v["content_digest"])

    def test_get(self):
        self.check(VECTORS["get"], None)

    def test_profile_is_strict(self):
        v = VECTORS["post"]
        good = v["signature_input"]
        for bad in [good.replace("sig1=", "sig2="), good.replace('"ed25519"', '"rsa-pss-sha512"'),
                    good.replace('tag="intertie"', 'tag="other"'), good + ', sig2=("@method")',
                    good.replace('"content-digest")', '"content-digest" "content-type")'),
                    good.replace(v["nonce"], "c2hvcnQ")]:
            with self.assertRaises(sig.ProtoError):
                sig.parse([bad], [v["signature"]], True)
        with self.assertRaises(sig.ProtoError):  # body present but digest not covered
            sig.parse([VECTORS["get"]["signature_input"]], [v["signature"]], True)


if __name__ == "__main__":
    unittest.main()
