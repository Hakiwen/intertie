# 0005: What is in Core

Date: 2026-10-29 · Status: accepted

The brief lists Core events as create, edit, delete and thread reply, and lists the
conformance levels as Core, Threads, Reactions, Files, Edits, Pull. Those two lists
overlap. Resolution:

- **Edits and deletes are Core**, not a level. They are about ten lines each, and a
  support channel where a wrong message can't be corrected or retracted is a
  liability. Slack, Teams and Mattermost all have them.
- **Thread replies are in Core's data model**; native thread UI is the `threads` level.
  A Core receiver must at least show replies inline, so no conversation is lost
  between a threaded and a flat implementation.
- **Serving pull is Core for homes.** The home already keeps a sequenced log, so
  `GET …/events?since=` is a few lines over it. It gives every peer gap repair after
  downtime, and it makes pull-only peers possible without the home doing anything
  special. *Operating* as a pull-only peer is a conformance **role** (`peer-pull`),
  not a level.
- **v0.1 does not require peers to be push-reachable.** Many internal tools sit
  behind VPNs. Homes must be reachable, because they accept submissions.
- Added `mentions` and `members` as levels (the brief lists them as capabilities).
  Dropped typing, read markers and presence from v0.1 with reasons
  (`spec/capabilities.md` § Not in v0.1).
- **Home transfer is v1**, per the brief.
