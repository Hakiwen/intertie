# 0006: Both Slack hosting modes are first-class

Date: 2026-10-29 · Status: accepted (Ben)

**Context.** Slack's 2025 API Terms restrict *third parties* from keeping copies of
Slack data. When a vendor hosts the adapter for a customer's workspace, the vendor is
a third-party app developer under those terms. I flagged this and proposed ranking the
self-hosted mode first until the question was settled.

**Decision.** Ben: "I'm ok with the flag, if the customers deal with the terms." The
docs therefore describe both modes as complete paths:

1. Self-hosted is listed first, because it carries no terms exposure.
2. Vendor-hosted gets full setup steps. It carries one plain note: the Slack org that
   installs the app is responsible for its own compliance with Slack's API Terms.
   There is no other warning label.

**Consequences.** Vendor-hosted mode deserves a one-click install: a distributed app,
OAuth, and one process serving many workspaces. That is the next adapter feature.
Until then, vendors run one instance per workspace.
