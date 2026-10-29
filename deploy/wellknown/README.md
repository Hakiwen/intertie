# Durable discovery documents (static hosting)

A registry listing is verified against the key published at
`https://<org>/.well-known/intertie`, so that document must stay up **after** the conformance
run, with **nothing running on the hub**. Each directory here is a complete static site for one
hostname:

| directory | hostname | what |
|---|---|---|
| `py.intertie.dev/` | `py.intertie.dev` | the independent Python implementation's identity (public key only) |

The runner's identity (`runner.intertie.dev`) is throwaway and needs no durable document.

## Hosting a site (pick one; DNS is set by whoever holds intertie.dev)

**A. Cloudflare Pages (recommended).** Create a Pages project from this directory (direct upload,
or a repo containing it), add the custom domain `py.intertie.dev`. The `_headers` file makes
`/.well-known/intertie` serve as `application/json` (the spec's media type) with a short cache.

**B. GitHub Pages.** Put the directory's contents (including `.nojekyll`, so `.well-known/` is
published, and `CNAME`) in a repo of its own with Pages enabled and custom domain `py.intertie.dev`.
Caveat: GitHub Pages cannot set headers and serves the extensionless file as
`application/octet-stream`. Signature verification (the registry's CI, `intertie-conformance
verify`) does not care, but strict clients that check the media type would refuse it; prefer A.

## The conformance run that produces the listing

1. `scripts/py-listing.sh init`, once (already done on the hub). It creates the identity: the
   key stays in `state/py-listing/` (mode 600, never committed), and it writes
   `py.intertie.dev/.well-known/intertie` here. Commit that public document.
2. During the run only, two tunnels: `py.intertie.dev → 127.0.0.1:8740` (the Python
   implementation, which serves its own live discovery document with the same key) and
   `runner.intertie.dev → 127.0.0.1:8790` (the conformance runner, which needs a reachable name
   for the push tests).
3. `scripts/py-listing.sh run`: runs the suite against `https://py.intertie.dev`, signs the report
   with py's key, verifies it. Outside dev mode the runner has one identity, so checks that need a
   second throwaway org (cross-org, non-participant, adversarial discovery) are reported as skipped;
   all of them already pass in CI in dev mode (`scripts/conformance-python.sh`).
4. Stop the tunnels; point `py.intertie.dev` at the static site (A or B).
5. Open a registry PR: `reports/intertie-py.json` (the signed report) and one entry:

   ```json
   { "name": "intertie-py", "vendor": "Intertie project (independent implementation)",
     "url": "https://github.com/Hakiwen/intertie/tree/main/implementations/python",
     "org": "py.intertie.dev", "kind": "native", "roles": ["home"],
     "levels": ["core", "security", "reactions"], "protocol": "0.1",
     "date": "YYYY-MM-DD", "report": "reports/intertie-py.json", "license": "Apache-2.0" }
   ```

   The registry's CI fetches the static document and verifies the signature.
