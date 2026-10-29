# 0004: Message text: Markdown, GFM-MIMI profile (no HTML)

Date: 2026-10-29 · Status: accepted

## Options
1. A small Markdown subset.
2. The MIMI content format (draft-ietf-mimi-content-09): deterministic **CBOR** with
   nested parts, dispositions, `inReplyTo`/`replaces`.
3. A structured rich-text tree (like Slack's `rich_text` blocks).

## Decision
`body.text` is Markdown in **MIMI's own GFM-MIMI profile** (GitHub-flavoured Markdown
with mandatory No-HTML), with a recommended subset for senders. Plain-text rendering is
conformant.

## Why
- **Degrades to plain text.** A receiver that renders nothing still shows readable
  text, which is what makes Core an afternoon.
- **MIMI-aligned without MIMI's weight.** GFM-MIMI is one of MIMI's three *required*
  media types, so a future Intertie↔MIMI gateway maps `text` one-to-one into a MIMI
  part. Adopting the MIMI container itself would put CBOR and its part model on every
  implementer, for features (multipart alternatives, external parts, expiry) that
  Core doesn't need.
- **Slack converts cleanly.** mrkdwn ↔ Markdown is a small, testable transform
  (`spec/slack-mapping.md`). A structured tree would need a renderer on every side.
- The relationship semantics borrow MIMI's: `thread` ≈ `inReplyTo` to a root, and
  `message.edit`/`message.delete` with `target` ≈ `replaces`. They are explicit event
  types because JSON makes that clearer than dispositions do.
