--------------------------- MODULE IntertieChannel ---------------------------
(***************************************************************************)
(* A model of one Intertie channel (spec/core.md §6-§7): the home's        *)
(* sequenced log, invites, submissions, push delivery over a lossy,        *)
(* duplicating, reordering network, gap buffering, honest and adversarial  *)
(* pulls, removal and rejoin.                                              *)
(*                                                                         *)
(* Checked properties:                                                     *)
(*   Contiguous       every peer applies an unbroken run of the home's log *)
(*                    (total order, no gaps), starting at its own join     *)
(*   NoPreJoinReads   no pull or push ever shows a peer an event from      *)
(*                    before its current join                              *)
(*   NoPostLeaveReads a departed peer sees nothing after its leave         *)
(*   UniqueIds        retried submissions are sequenced at most once       *)
(*   SingleUseInvites an invite admits at most one membership              *)
(*   AppendOnly       the home never rewrites or drops sequenced history   *)
(*   CatchUp          (liveness) an active peer eventually applies the log *)
(*                                                                         *)
(* ClampPull and StrictInvites switch the two defences that the 2026-10-29 *)
(* security review found missing; the Bug*.cfg configurations turn each    *)
(* off and TLC must then find the violation.                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Peers,          \* peer orgs, e.g. {p1, p2}
    Tokens,         \* invite tokens the home may issue
    MsgIds,         \* ids of messages peers may submit
    MaxLog,         \* bound on the log length (keeps the state space finite)
    ClampPull,      \* TRUE: pull never returns seq <= the caller's join (the fix)
    StrictInvites   \* TRUE: a used token is dead, even for the org that used it (the fix)

Home == "home"
Kinds == {"join", "leave", "msg"}
Entry == [kind: Kinds, org: Peers \cup {Home}, id: MsgIds \cup Peers]

VARIABLES
    log,          \* the home's sequenced log: Seq(Entry); seq n is log[n]
    status,       \* [Peers -> {"out", "active", "left"}]
    joinAt,       \* [Peers -> Nat]: Len(log) when the peer's current membership began
    leaveAt,      \* [Peers -> Nat]: seq of the peer's leave event (0 while active)
    token,        \* [Tokens -> {"fresh", "issued", "used"}]
    accepts,      \* [Tokens -> Nat]: memberships admitted by each token
    usedBy,       \* [Tokens -> Peers \cup {"none"}]
    cursor,       \* [Peers -> Nat]: last seq the home knows the peer accepted
    base,         \* [Peers -> Nat]: the peer's starting point (= joinAt at accept)
    applied,      \* [Peers -> Seq(Nat)]: seqs the peer applied, in order
    buffer,       \* [Peers -> SUBSET Nat]: out-of-order seqs held for later
    seen,         \* [Peers -> SUBSET Nat]: every seq any response showed the peer this membership
    net,          \* in-flight pushes: SUBSET (Peers \X Nat)
    submitted     \* in-flight submissions (never removed: models retries): SUBSET (Peers \X MsgIds)

vars == <<log, status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, net, submitted>>

Max(a, b) == IF a > b THEN a ELSE b
Pos(p) == base[p] + Len(applied[p])
UpTo(p) == IF status[p] = "active" THEN Len(log) ELSE leaveAt[p]
Range(lo, hi) == (lo + 1)..hi
SeqIds == {log[i].id : i \in {j \in 1..Len(log) : log[j].kind = "msg"}}

\* Apply seq s at peer p: in order if it is next (then drain the buffer), else buffer or drop.
Next1(p, s, B) ==
    LET pos == Pos(p)
        held == B \cup {s}
        top == CHOOSE k \in pos..MaxLog : Range(pos, k) \subseteq held /\ (k + 1) \notin held
    IN IF s = pos + 1
       THEN [ap |-> applied[p] \o [i \in 1..(top - pos) |-> pos + i], buf |-> {x \in held : x > top}]
       ELSE IF s > pos + 1
            THEN [ap |-> applied[p], buf |-> held]
            ELSE [ap |-> applied[p], buf |-> B]

Init ==
    /\ log = <<>>
    /\ status = [p \in Peers |-> "out"]
    /\ joinAt = [p \in Peers |-> 0]
    /\ leaveAt = [p \in Peers |-> 0]
    /\ token = [t \in Tokens |-> "fresh"]
    /\ accepts = [t \in Tokens |-> 0]
    /\ usedBy = [t \in Tokens |-> "none"]
    /\ cursor = [p \in Peers |-> 0]
    /\ base = [p \in Peers |-> 0]
    /\ applied = [p \in Peers |-> <<>>]
    /\ buffer = [p \in Peers |-> {}]
    /\ seen = [p \in Peers |-> {}]
    /\ net = {}
    /\ submitted = {}

\* The home admin creates an invite.
Issue(t) ==
    /\ token[t] = "fresh"
    /\ token' = [token EXCEPT ![t] = "issued"]
    /\ UNCHANGED <<log, status, joinAt, leaveAt, accepts, usedBy, cursor, base, applied, buffer, seen, net, submitted>>

\* A peer accepts: the home claims the token and sequences peer.join (spec/core.md §6).
Accept(p, t) ==
    /\ status[p] # "active"
    /\ Len(log) < MaxLog
    /\ \/ token[t] = "issued"
       \/ (~StrictInvites /\ token[t] = "used" /\ usedBy[t] = p)   \* the reviewed bug: reuse by the same org
    /\ token' = [token EXCEPT ![t] = "used"]
    /\ accepts' = [accepts EXCEPT ![t] = @ + 1]
    /\ usedBy' = [usedBy EXCEPT ![t] = p]
    /\ status' = [status EXCEPT ![p] = "active"]
    /\ joinAt' = [joinAt EXCEPT ![p] = Len(log)]
    /\ leaveAt' = [leaveAt EXCEPT ![p] = 0]
    /\ cursor' = [cursor EXCEPT ![p] = Len(log)]
    /\ base' = [base EXCEPT ![p] = Len(log)]
    /\ applied' = [applied EXCEPT ![p] = <<>>]
    /\ buffer' = [buffer EXCEPT ![p] = {}]
    /\ seen' = [seen EXCEPT ![p] = {}]
    /\ net' = {x \in net : x[1] # p}
    /\ log' = Append(log, [kind |-> "join", org |-> p, id |-> p])
    /\ UNCHANGED submitted

\* The home's own users post.
HomePost(m) ==
    /\ Len(log) < MaxLog
    /\ m \notin SeqIds
    /\ log' = Append(log, [kind |-> "msg", org |-> Home, id |-> m])
    /\ UNCHANGED <<status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, net, submitted>>

\* An active peer submits (and may keep retrying: submissions stay in flight).
Submit(p, m) ==
    /\ status[p] = "active"
    /\ submitted' = submitted \cup {<<p, m>>}
    /\ UNCHANGED <<log, status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, net>>

\* The home receives a (possibly repeated) submission: participants only, deduplicated by id.
Sequence(p, m) ==
    /\ <<p, m>> \in submitted
    /\ status[p] = "active"
    /\ m \notin SeqIds
    /\ Len(log) < MaxLog
    /\ log' = Append(log, [kind |-> "msg", org |-> p, id |-> m])
    /\ UNCHANGED <<status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, net, submitted>>

\* The home removes a peer (or the peer leaves): peer.leave is sequenced and is its last event.
Remove(p) ==
    /\ status[p] = "active"
    /\ Len(log) < MaxLog
    /\ log' = Append(log, [kind |-> "leave", org |-> p, id |-> p])
    /\ status' = [status EXCEPT ![p] = "left"]
    /\ leaveAt' = [leaveAt EXCEPT ![p] = Len(log) + 1]
    /\ UNCHANGED <<joinAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, net, submitted>>

\* The home pushes the next seq after the cursor (it may resend: duplicates are possible).
Push(p) ==
    /\ status[p] \in {"active", "left"}
    /\ cursor[p] < UpTo(p)
    /\ net' = net \cup {<<p, cursor[p] + 1>>}
    /\ UNCHANGED <<log, status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, submitted>>

\* A push arrives (in any order). The peer applies or buffers it; the home's cursor advances on the ack.
Deliver(p, s) ==
    /\ <<p, s>> \in net
    /\ status[p] \in {"active", "left"}
    /\ LET r == Next1(p, s, buffer[p]) IN
         /\ applied' = [applied EXCEPT ![p] = r.ap]
         /\ buffer' = [buffer EXCEPT ![p] = r.buf]
    /\ seen' = [seen EXCEPT ![p] = @ \cup {s}]
    /\ cursor' = [cursor EXCEPT ![p] = Max(@, s)]
    /\ net' = net \ {<<p, s>>}
    /\ UNCHANGED <<log, status, joinAt, leaveAt, token, accepts, usedBy, base, submitted>>

\* The network loses a push.
Lose(p, s) ==
    /\ <<p, s>> \in net
    /\ net' = net \ {<<p, s>>}
    /\ UNCHANGED <<log, status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, seen, submitted>>

\* What the home's pull endpoint returns for `since` (spec/core.md §7.3).
PullRange(p, since) ==
    LET lo == IF ClampPull THEN Max(since, joinAt[p]) ELSE since
    IN Range(lo, UpTo(p))

\* An honest peer pulls from its position (gap repair, or a pull-only peer).
HonestPull(p) ==
    /\ status[p] \in {"active", "left"}
    /\ LET resp == PullRange(p, Pos(p))
           hi == IF resp = {} THEN Pos(p) ELSE UpTo(p)
       IN /\ applied' = [applied EXCEPT ![p] = @ \o [i \in 1..(hi - Pos(p)) |-> Pos(p) + i]]
          /\ buffer' = [buffer EXCEPT ![p] = {x \in @ : x > hi}]
          /\ seen' = [seen EXCEPT ![p] = @ \cup resp]
    /\ UNCHANGED <<log, status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, net, submitted>>

\* A malicious peer asks for any range it likes.
SnoopPull(p, since) ==
    /\ status[p] \in {"active", "left"}
    /\ seen' = [seen EXCEPT ![p] = @ \cup PullRange(p, since)]
    /\ UNCHANGED <<log, status, joinAt, leaveAt, token, accepts, usedBy, cursor, base, applied, buffer, net, submitted>>

Next ==
    \/ \E t \in Tokens : Issue(t)
    \/ \E p \in Peers, t \in Tokens : Accept(p, t)
    \/ \E m \in MsgIds : HomePost(m)
    \/ \E p \in Peers, m \in MsgIds : Submit(p, m) \/ Sequence(p, m)
    \/ \E p \in Peers : Remove(p) \/ Push(p) \/ HonestPull(p)
    \/ \E p \in Peers, s \in 1..MaxLog : Deliver(p, s) \/ Lose(p, s)
    \/ \E p \in Peers, since \in 0..MaxLog : SnoopPull(p, since)

Fairness == \A p \in Peers : WF_vars(HonestPull(p))
Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
    /\ log \in Seq(Entry) /\ Len(log) <= MaxLog
    /\ status \in [Peers -> {"out", "active", "left"}]
    /\ token \in [Tokens -> {"fresh", "issued", "used"}]
    /\ \A p \in Peers : Pos(p) <= Len(log) /\ buffer[p] \subseteq 1..MaxLog

\* Total order, no gaps: a peer's applied seqs are exactly base+1, base+2, ...
Contiguous == \A p \in Peers : \A i \in 1..Len(applied[p]) : applied[p][i] = base[p] + i

\* Everything a peer applied belongs to its current membership.
AppliedInMembership ==
    \A p \in Peers : \A i \in 1..Len(applied[p]) :
        /\ applied[p][i] > joinAt[p]
        /\ (status[p] = "left") => applied[p][i] <= leaveAt[p]

NoPreJoinReads == \A p \in Peers : \A s \in seen[p] : s > joinAt[p]

NoPostLeaveReads == \A p \in Peers : status[p] = "left" => \A s \in seen[p] : s <= leaveAt[p]

UniqueIds ==
    \A i, j \in 1..Len(log) :
        (i # j /\ log[i].kind = "msg" /\ log[j].kind = "msg") => log[i].id # log[j].id

SingleUseInvites == \A t \in Tokens : accepts[t] <= 1

\* History is never rewritten: every step only appends.
AppendOnly == [][Len(log') >= Len(log) /\ SubSeq(log', 1, Len(log)) = log]_log

\* Liveness: an active peer catches up with every seq that existed while it was active.
CatchUp == \A p \in Peers, n \in 1..MaxLog :
    (status[p] = "active" /\ Len(log) >= n /\ joinAt[p] < n) ~> (status[p] # "active" \/ Pos(p) >= n)
=============================================================================
