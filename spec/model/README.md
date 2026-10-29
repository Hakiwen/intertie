# A TLA+ model of an Intertie channel

[`IntertieChannel.tla`](IntertieChannel.tla) models one channel, following spec/core.md
§6–§7:

- the home's sequenced log;
- invites, with a token claimed when it is accepted;
- peer submissions, retried freely and deduplicated by id;
- push delivery over a network that loses, duplicates and reorders messages;
- gap buffering at the peer;
- honest pulls, plus **adversarial pulls** with any `since`;
- removal, and rejoin with a new invite.

TLC checks:

| property | kind | meaning |
|---|---|---|
| `Contiguous` | invariant | Each peer applies an unbroken run `join+1, join+2, …` of the home's log. That gives total order with no gaps. |
| `AppliedInMembership` | invariant | Everything a peer applied belongs to its current membership. |
| `NoPreJoinReads` | invariant | No push or pull, malicious ones included, ever shows a peer an event from before its join. |
| `NoPostLeaveReads` | invariant | A peer that left sees nothing after its leave. |
| `UniqueIds` | invariant | Retried submissions are sequenced at most once. |
| `SingleUseInvites` | invariant | An invite admits at most one membership. |
| `AppendOnly` | action property | The home never rewrites or drops sequenced history. |
| `CatchUp` | liveness (weak fairness on pull) | An active peer eventually applies every event that exists while it is a member. |

## Configurations

- [`IntertieChannel.cfg`](IntertieChannel.cfg) is the protocol as specified. It uses 2
  peers, 2 invite tokens, 1 message id and a log of at most 4 events. That gives 834,352
  distinct states (14.2 M generated), all properties hold, and the check takes about
  3 minutes on a laptop.
- [`BugPreJoinRead.cfg`](BugPreJoinRead.cfg) and [`BugInviteReuse.cfg`](BugInviteReuse.cfg)
  each switch off one defence that the 2026-10-29 security review found missing in the
  reference implementation. TLC must find a counterexample for each, within a few hundred
  states. This shows that the properties are not vacuous and that the model would have
  caught those bugs.

Run all three with `scripts/check-model.sh`. It needs Java 11 or later, and it downloads
`tla2tools.jar` v1.7.4 and verifies its SHA-256. CI runs the same script in
`.github/workflows/model.yml`. The last local run is in [`tlc-run.log`](tlc-run.log).

## What it does not model

- Cryptography and signatures. The model assumes authenticated orgs; the signing profile
  is covered by test vectors and the conformance security suite.
- Multiple channels.
- Edits and deletes.
- File transfer.
- Content.
- Home failure and home transfer.

The model is about ordering, membership and invites, where the state-machine bugs live.
