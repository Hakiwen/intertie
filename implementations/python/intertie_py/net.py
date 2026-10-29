"""Outbound HTTP with the security.md SSRF rules, and discovery (core.md §3)."""
import http.client, ipaddress, json, re, socket, ssl, threading, time
from urllib.parse import urlsplit

from . import sig

DNS_NAME = re.compile(r"(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+")
DEV_NAME = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?")
KID = re.compile(r"[A-Za-z0-9._-]{1,64}")
MAX_DISCOVERY = 64 * 1024


class FetchError(Exception):
    pass


def valid_org(org, dev) -> bool:
    return isinstance(org, str) and bool((DEV_NAME if dev else DNS_NAME).fullmatch(org))


def ip_allowed(addr: str, dev: bool) -> bool:
    ip = ipaddress.ip_address(addr.split("%")[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if dev:  # core.md §10: dev mode allows loopback and nothing else
        return ip.is_loopback
    return ip.is_global and not ip.is_multicast and not ip.is_unspecified


def request(url, method="GET", body=None, headers=None, dev=False, timeout=30.0, max_bytes=4 << 20):
    """One request, no redirects, connecting only to an address that passed the check."""
    u = urlsplit(url)
    if u.scheme != "https" and not (dev and u.scheme == "http"):
        raise FetchError(f"scheme not allowed: {url}")
    if not u.hostname:
        raise FetchError("no host")
    port = u.port or (443 if u.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(u.hostname, port, type=socket.SOCK_STREAM)
    except OSError as e:
        raise FetchError(f"dns: {e}")
    addrs = [i[4] for i in infos if ip_allowed(i[4][0], dev)]
    if not addrs:
        raise FetchError(f"address refused for {u.hostname}")
    sock = None
    for a in addrs:  # connect to the checked address itself (no second lookup)
        try:
            sock = socket.create_connection(a[:2], timeout=min(10.0, timeout))
            break
        except OSError:
            continue
    if sock is None:
        raise FetchError(f"connect failed: {u.netloc}")
    sock.settimeout(timeout)
    if u.scheme == "https":
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
    conn = http.client.HTTPConnection(u.hostname, port, timeout=timeout)
    conn.sock = sock
    try:
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise FetchError("response too large")
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
    except (OSError, http.client.HTTPException) as e:
        raise FetchError(f"http: {e}")
    finally:
        conn.close()


def max_age(cache_control: str) -> float:
    m = re.search(r"max-age=(\d+)", cache_control or "")
    return 3600.0 if not m else float(min(max(int(m[1]), 60), 86400))


class Directory:
    """Caches discovery documents; resolves (org, kid) to a public key."""

    def __init__(self, dev: bool):
        self.dev, self.cache, self.refetched, self.lock = dev, {}, {}, threading.Lock()

    def fetch(self, org) -> dict:
        if not valid_org(org, self.dev):
            raise FetchError(f"bad org name {org!r}")
        scheme = "http" if self.dev else "https"
        status, hdrs, data = request(f"{scheme}://{org}/.well-known/intertie", dev=self.dev,
                                     timeout=10.0, max_bytes=MAX_DISCOVERY)
        if status != 200:  # includes every 3xx: redirects are never followed
            raise FetchError(f"discovery {org}: HTTP {status}")
        try:
            doc = json.loads(data)
        except (ValueError, RecursionError):
            raise FetchError("discovery: not JSON")
        if not isinstance(doc, dict) or doc.get("org") != org:
            raise FetchError("discovery: org mismatch")
        v = re.fullmatch(r"(\d+)\.(\d+)", str(doc.get("intertie", "")))
        if not v or v[1] != "0" or int(v[2]) < 1:
            raise FetchError(f"discovery: incompatible version {doc.get('intertie')!r}")
        ep = doc.get("endpoint")
        u = urlsplit(ep) if isinstance(ep, str) else None
        if (not u or "?" in ep or "#" in ep or not u.hostname
                or u.scheme not in (("http", "https") if self.dev else ("https",))):
            raise FetchError("discovery: bad endpoint")
        keys = doc.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= 16:
            raise FetchError("discovery: bad keys")
        parsed = {}
        for k in keys:
            if (not isinstance(k, dict) or k.get("kty") != "OKP" or k.get("crv") != "Ed25519"
                    or not KID.fullmatch(str(k.get("kid", ""))) or not isinstance(k.get("x"), str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{43}", k["x"])):
                raise FetchError("discovery: bad key")
            parsed[k["kid"]] = sig.public_key(k["x"])
        if doc.get("delivery", "push") not in ("push", "pull"):
            raise FetchError("discovery: bad delivery")
        doc = dict(doc, endpoint=ep.rstrip("/"), _keys=parsed)
        with self.lock:
            self.cache[org] = (doc, time.time() + max_age(hdrs.get("cache-control")))
        return doc

    def resolve(self, org) -> dict:
        with self.lock:
            hit = self.cache.get(org)
        if hit and hit[1] > time.time():
            return hit[0]
        return self.fetch(org)

    def key(self, org, kid):
        doc = self.resolve(org)
        if kid in doc["_keys"]:
            return doc["_keys"][kid]
        with self.lock:  # unknown kid: re-fetch at most once per 60 s per org
            if time.time() - self.refetched.get(org, 0) < 60:
                return None
            self.refetched[org] = time.time()
        return self.fetch(org)["_keys"].get(kid)
