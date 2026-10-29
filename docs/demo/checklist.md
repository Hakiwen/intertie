# Two-Slack demo checklist

Open both workspaces side by side, each in its own `#intertie-demo`. **A** is the home,
the side that shared the channel. **B** accepted the invite.

Each line is one action and what should then happen on the other side.

| # | Do this | Where | Expect on the other side |
|---|---|---|---|
| 1 | Post `hello from A, *bold* and a <link>` | A | An app post with your name and avatar, labelled `(localhost:8711)`, bold intact |
| 2 | Post `hi back from B` | B | It appears in A, labelled `(localhost:8712)` |
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

The terminal side of the same session (relay logs from both adapters) goes in
`docs/demo/transcript-*.md`.
