# Demo checklist: Slack ⇄ Slack ⇄ Matrix

Open three windows side by side:

- **A**: Slack workspace A, `#intertie-demo`. A is the **home**: it shared the channel.
- **B**: Slack workspace B, `#intertie-demo`.
- **M**: Element, the `intertie-demo` room, signed in as **yourself** (not the bot).

B and M each accepted an invite from A. Everything fans out through A, so a message in
any one window appears in the other two. Remote people show as `Name (org)`: Slack
shows them as app posts, Matrix as messages from the bot prefixed with the name.

Each line is one action and what should then happen on the other side.

| # | Do this | Where | Expect on the other side |
|---|---|---|---|
| 1 | Post `hello from A, *bold* and a <link>` | A | In B: an app post with your name and avatar, labelled `(localhost:8711)`, bold intact. In M: `Name (localhost:8711): hello…`, bold intact |
| 2 | Post `hi back from B` | B | It appears in A and M, labelled `(localhost:8712)` |
| 2m | Post `and hello from Matrix` | M | It appears in A and B, labelled `(localhost:8713)` |
| 3m | Reply **in a thread** on the step-1 message | M | The reply lands in that thread in A and B |
| 4m | React 👍 on the step-2 message | M | 👍 appears on the original in B (added by the app) |
| 5m | **Edit** your step-2m message | M | A and B update |
| 6m | **Delete** (remove) your step-2m message | M | It disappears in A and B |
| 7m | Have someone else in the room post, or post from a second account | M | It is **not** shared; the room gets one notice explaining why |
| 3 | Reply **in a thread** on the message from step 2 | A | The reply appears in B *inside that thread* |
| 4 | Reply in the same thread | B | It appears in A's thread |
| 5 | **Edit** your thread reply from step 4 | B | A's copy updates |
| 6 | React 👀 on the mirrored step-1 message | B | 👀 appears on your original in A, added by the app |
| 7 | React 🎉 on the mirrored step-2 message | A | 🎉 appears on the original in B |
| 8 | Remove the 👀 from step 6 | B | It disappears in A |
| 9 | Upload a screenshot or a small file | A | The file appears in B, posted by the app, with "↑ from …" |
| 10 | Upload a file | B | It appears in A |
| 11 | Post `delete me`, then **delete** it | A | It appears in B, then disappears |
| 12 | Type `@here test` | A | B shows the text `@here test` and **pings nobody** |
| 13 | `/intertie status` | either | A private reply saying it is shared, plus the other org |
| 14 | Post in any *other* channel | A | **Nothing** shows up in B (only linked channels are shared) |

Screenshots worth taking: steps 1–2 side by side, the thread from steps 3–5, the
reactions from steps 6–7, and the file from step 9.

If Teams is set up (docs/teams-setup.md), a fourth window **T** shows the Teams channel
`intertie-demo`:

| # | Do this | Where | Expect |
|---|---|---|---|
| t1 | Post `hello from **Teams**` | T | It appears in A, B and M, labelled `(localhost:8714)` |
| t2 | Reply in the thread of a remote message | T | It lands in that thread everywhere |
| t3 | React ❤️ on a remote message (one posted by the Intertie bot) | T | ❤️ on the original elsewhere |
| t4 | React 🎉 on the step-t1 message | A | The Teams copy shows an italic footer `🎉 1`, because Teams bots can't add reactions |
| t5 | Edit, then delete, your step-t1 message | T | It updates, then disappears, everywhere |

Matrix-side differences, by design (spec/matrix-mapping.md):

- in bot mode, remote reactions show as one bot reaction per emoji;
- encrypted rooms are refused;
- only your own Matrix id is relayed.

The terminal side of the same session (relay logs from all three) goes in
`docs/demo/transcript-*.md`.
