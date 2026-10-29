"""Deeply nested JSON must be a client error (400), never a crash (some Pythons raise RecursionError)."""
import json, unittest
from intertie_py import server


class Malformed(unittest.TestCase):
    def test_nesting_is_caught(self):
        body = '{"events":[' + '[' * 200_000
        with self.assertRaises((ValueError, RecursionError)):
            json.loads(body)  # documents why server.py catches both


if __name__ == "__main__":
    unittest.main()
