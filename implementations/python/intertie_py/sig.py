"""RFC 9421 fixed profile (core.md §4) and RFC 9530 Content-Digest."""
import base64, hashlib, re, secrets, time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


class ProtoError(Exception):
    def __init__(self, status, code, message=""):
        super().__init__(f"{status} {code} {message}")
        self.status, self.code, self.message = status, code, message or code


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def private_key(seed: bytes) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(seed)


def public_x(key: Ed25519PrivateKey) -> str:
    return b64u(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))


def public_key(x: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(b64u_dec(x))


def content_digest(body: bytes) -> str:
    return "sha-256=:" + base64.b64encode(hashlib.sha256(body).digest()).decode() + ":"


def components(has_body: bool) -> str:
    return '("@method" "@target-uri" "content-digest")' if has_body else '("@method" "@target-uri")'


def signature_params(has_body, created, keyid, nonce) -> str:
    return (f'{components(has_body)};created={created};keyid="{keyid}";'
            f'alg="ed25519";nonce="{nonce}";tag="intertie"')


def signature_base(method, target_uri, params, digest=None) -> str:
    lines = [f'"@method": {method.upper()}', f'"@target-uri": {target_uri}']
    if digest is not None:
        lines.append(f'"content-digest": {digest}')
    lines.append(f'"@signature-params": {params}')
    return "\n".join(lines)


def sign_headers(key, keyid, method, target_uri, body=None, created=None, nonce=None) -> dict:
    """Headers for a signed request. `body` is the exact bytes sent, or None."""
    created = int(time.time()) if created is None else created
    nonce = nonce or b64u(secrets.token_bytes(18))
    params = signature_params(bool(body), created, keyid, nonce)
    headers = {}
    digest = None
    if body:
        digest = headers["Content-Digest"] = content_digest(body)
    base = signature_base(method, target_uri, params, digest)
    sig = base64.b64encode(key.sign(base.encode())).decode()
    headers["Signature-Input"] = "sig1=" + params
    headers["Signature"] = f"sig1=:{sig}:"
    return headers


# Strict: exactly one member, label sig1, parameters in the profile's order.
_INPUT = re.compile(r'sig1=(\([^)]*\));created=(-?\d{1,15});keyid="([^"\\]*)";'
                    r'alg="([^"\\]*)";nonce="([^"\\]*)";tag="([^"\\]*)"')
_SIG = re.compile(r"sig1=:([A-Za-z0-9+/]+={0,2}):")
_NONCE = re.compile(r"[A-Za-z0-9_-]+")


def parse(sig_inputs, sigs, has_body) -> dict:
    """Step 1 of §4 verification. Takes lists of header values."""
    bad = ProtoError(401, "bad_signature", "signature profile mismatch")
    if len(sig_inputs or []) != 1 or len(sigs or []) != 1:
        raise bad
    m, s = _INPUT.fullmatch(sig_inputs[0].strip()), _SIG.fullmatch(sigs[0].strip())
    if not m or not s or m[1] != components(has_body) or m[4] != "ed25519" or m[6] != "intertie":
        raise bad
    if not _NONCE.fullmatch(m[5]) or len(b64u_dec(m[5])) < 16:
        raise ProtoError(401, "bad_signature", "nonce must be >= 16 bytes base64url")
    try:
        sig = base64.b64decode(s[1], validate=True)
    except ValueError:
        raise bad
    return {"params": sig_inputs[0].strip()[5:], "created": int(m[2]), "keyid": m[3],
            "nonce": m[5], "sig": sig}


def verify(pub: Ed25519PublicKey, sig: bytes, base: str) -> bool:
    try:
        pub.verify(sig, base.encode())
        return True
    except (InvalidSignature, ValueError):
        return False
