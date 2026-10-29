# 0003: Request signing: RFC 9421 HTTP Message Signatures, fixed profile

Date: 2026-10-29 · Status: accepted

## Options
1. **RFC 9421** HTTP Message Signatures with Ed25519, plus RFC 9530 Content-Digest.
2. **Detached JWS** (RFC 7515 + RFC 7797 unencoded payload) over a canonical string
   of (method, path, timestamp, body hash).
3. A bespoke header (Ed25519 over our own canonical string).

## Library availability (Ed25519 is the constraint)
| | RFC 9421 | JWS EdDSA | raw Ed25519 |
|---|---|---|---|
| TypeScript/Node | `http-message-signatures` (npm); or ~40 lines over `node:crypto` | `jose` | `node:crypto` (built in) |
| Go | `github.com/yaronf/httpsign`, `common-fate/httpsig` | `go-jose` | `crypto/ed25519` (stdlib) |
| Python | `http-message-signatures` (PyPI) | `joserfc`, `PyJWT[crypto]` | `cryptography` / `PyNaCl` (not stdlib) |

## Decision
RFC 9421, with a **fixed profile** that removes all its flexibility: always the
`sig1` label, always the same covered components, always the same parameters, in the
same order. In a fixed profile the signature base is four lines of string
concatenation, so an implementer needs no RFC 9421 library at all, only Ed25519 and
SHA-256, which every platform has. Those who want a library have one in each language.

## Why not JWS
JWS also needs its own canonical string of method, path and so on, which is option 3
dressed in JOSE. It adds base64url header and payload plumbing and an `alg` field that
must be pinned anyway (to avoid alg-confusion). It saves nothing over the fixed 9421
profile and isn't a standard for *HTTP request* signing. RFC 9421 is, and
ActivityPub servers (Mastodon) are moving to it, so a future gateway can reuse code.

## Why not bespoke
Same code size as the fixed profile, with no standard behind it to review.

## Consequences
- Verifiers must reconstruct `@target-uri` from their external URL. That is a pitfall
  behind proxies, so it is called out in Core §4.
- Responses are unsigned (TLS). Pull responses therefore rely on TLS for integrity,
  and in loopback dev mode there is none. Acceptable for v0.1.
- Test vectors in `spec/test-vectors/` pin the exact bytes.
