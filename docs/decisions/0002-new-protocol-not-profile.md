# 0002: A new small protocol, not a Matrix or MIMI profile

Date: 2026-10-29 · Status: accepted

Full reasoning, including where this disagrees with the brief, lives in
[`docs/landscape.md` § Decision record](../landscape.md#decision-record-a-new-small-protocol-not-a-matrix-or-mimi-profile).

Summary: a Matrix federation peer cannot be subset to an afternoon without being
non-conformant; MIMI is unfinished and MLS-mandatory, which is moot on a Slack side.
Intertie borrows MIMI's participant-hub ("home") model, DNS-named org identity, and
RFC 9421 signatures, and keeps a gateway path open to Matrix/MIMI as later adapters.
