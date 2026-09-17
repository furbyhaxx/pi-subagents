# Agent messaging and the shared blackboard

Two agents working on the same problem cannot tell each other anything. Every
finding travels up to whoever spawned them and back down again, if it travels at
all — and a fan-out of ten agents auditing ten files rediscovers the same fact
ten times.

This guide is for **anyone running more than one agent at a time**: what the
`AgentMessage` and `Blackboard` tools do, who can address whom, what an incoming
message costs the agent that receives it, and how to configure or switch the
whole thing off. For the tool parameter tables, see the
[README](../README.md#agentmessage).

---

## The one idea

**SQLite is the only source of truth.** A single database per scope holds the
roster of live agents, every mailbox, and the blackboard. A message is a row; a
board entry is a row; nothing is in flight anywhere else.

A Unix-socket bus sits beside it carrying *advisory* wakeups — "something
changed, look now" — and never any content. If the socket is missing, busy,
stale, or owned by a process that just died, everything still works: the store is
polled every five seconds while idle, and every 250 ms while an agent is blocked
waiting. The socket only collapses that wait to a round trip.

That split is what makes the feature safe to leave on. The failure mode of the
transport is *latency*, never a lost message.

## Scope: who can talk to whom

By default, scope is the **project** — every pi session in the same repository
shares one store, one roster and one bus. That is the case the feature is for: a
main session in one terminal, another in a second, and the subagents of both
able to reach each other.

```jsonc
// .pi/subagents.json
{ "messaging": { "scope": "project" } }   // default
{ "messaging": { "scope": "session" } }   // only this session's own agents
```

The store lives under `<agent dir>/messaging/<project-hash>/messaging.sqlite3`,
keyed by the resolved repository root. Switching scope points at a different
store; opening a store that was created under a different scope mode is a hard
error rather than a silent merge of two populations.

## Addressing

Every addressable participant has an id and usually a handle:

| Participant | Id | Handle |
|---|---|---|
| A top-level subagent | its agent id | its type-derived handle (`explore-2`), or the `name` the orchestrator gave it |
| A main session | `main:<session-id>` | `main-<short-id>`, or the session name if it has one |
| A nested child (an agent spawned by an agent) | — | not addressable |

`to` is resolved in this order, and the first rule that produces exactly one
match wins:

1. an exact agent id,
2. a handle owned by the **caller's own session**,
3. a handle that is unique across the whole scope,
4. otherwise the call is refused as `ambiguous` and lists the candidates.

Candidates are qualified by session — `explore@9f3a1c` — using the shortest
prefix that distinguishes them, never shorter than six characters. Send to that
and it resolves.

```jsonc
{ "op": "send", "to": "explore-2", "message": "admin.ts has no auth middleware" }
{ "op": "send", "to": "explore@9f3a1c", "message": "..." }          // another session's
{ "op": "send", "to": "main", "message": "blocked, need a decision" } // your own main
```

**Nested children are deliberately not peers.** They are owned by the agent that
spawned them, stopped when it settles, and have no independent lifecycle to
deliver into; addressing one is refused with `reason: "nested-child"`.

**Isolated agents get neither tool.** An agent with `isolated: true` has
explicitly asked for built-ins only, and messaging is an injected tool.

## What an incoming message costs the recipient

This is the setting worth understanding, because it is the only one that spends
a model's context without it asking. It belongs to the **reader**, never the
sender: `messaging.surface`, overridable per agent with `messaging_surface` in
frontmatter.

| Surface | The recipient gets | Receipt |
|---|---|---|
| `off` | nothing — the row waits in the mailbox until the agent calls `inbox` | `queued` |
| `ui` (default) | one line at the next turn boundary: who wrote, how many are unread, and that `AgentMessage op:"inbox"` fetches them. Never the body | `injected`, `surface: "notice"` |
| `context` | the full message body, wrapped and attributed | `injected`, `surface: "body"` |

The default is a compromise with a reason. Pure display-only is coherent but
inert — an agent mid-task has no reason to speculatively call `inbox`, so
messages would rot until the run ended. A one-line notice costs a couple of
dozen tokens and hands the decision to the recipient, which is the property
worth protecting: **a sender cannot spend an unbounded amount of someone else's
context.**

`context` should stay rare. Pulling is almost always better: `op: "inbox"` and
`Blackboard op: "watch"` are one cheap call each, and put exactly what the agent
asked for into context at a moment it chose.

**Coalescing.** Messages arriving between two turn boundaries are delivered as
one batch: one notice naming the distinct senders and the unread count, one wake,
one injection. Under `context` a batch carries at most ten bodies; the rest stay
queued (`reason: "batch-deferred"`) and ride the next boundary, because a notice
collapses for free and a body does not.

**Waking.** A message to an agent that has finished but is still resumable wakes
it for a turn — not only a `request`. A finished agent is a resumable
conversation, and a message rotting in its mailbox is worse than a turn spent.
Two bounds keep that from looping: a wake budget (`maxWakesPerMinute`, default 6)
and a hop cap (`maxHops`, default 4) that a woken agent's own outbound messages
inherit, so two idle agents cannot ping-pong each other awake.

Broadcast never wakes anyone. It reaches live subagents only, never mains.

## Receipts

A receipt describes **delivery**, never the reply. A reply is a separate message
carrying the same `correlationId`.

| Status | Meaning |
|---|---|
| `injected` | in the recipient's context at its next turn (`surface` says notice or body) |
| `woken` | the recipient was settled and has been resumed for a turn |
| `queued` | accepted and waiting — with a `reason` when something specific held it back |
| `accepted` | the recipient belongs to another live pi process, which will deliver it |
| `failed` | the recipient is gone; the message is marked undeliverable |

## The blackboard

A message is a conversation; the board is what a fan-out leaves behind. Entries
are `topic` + `key`, with a value, an author, a revision and timestamps.

```jsonc
{ "op": "put", "topic": "findings", "key": "auth-routes", "value": { "missing": ["requireAuth"] } }
{ "op": "get", "topic": "findings", "key": "auth-routes" }
{ "op": "list", "topic": "findings" }
{ "op": "delete", "topic": "findings", "key": "stale" }
{ "op": "watch", "topic": "findings", "timeout_ms": 30000 }
```

**Authorship is assigned, never submitted.** There is no `author` parameter on
the tool; the service stamps the caller's own name. An agent that happens to be
handled `operator` is recorded by its id instead, so naming an agent after the
human does not buy it the human's privileges.

**Optimistic concurrency.** Pass `if_revision` and the write applies only if the
entry is still at that revision (`0` = must not exist). A mismatch is an
*answer*, not an error:

```jsonc
{
  "ok": false,
  "reason": "revision-conflict",
  "currentRevision": 3,
  "currentValue": { "missing": ["requireAuth", "rateLimit"] },
  "author": "explore-2",
  "updatedAt": 1763500000000
}
```

The agent can then merge, retry, or defer — which is why it comes back readable
rather than as a tool failure.

**`watch` starts from now.** Omit `since` and the call reports only what happens
next; pass `since: 0` to replay the whole log. Every result carries a `cursor` to
pass to the next call, so a watcher never re-reads what it has seen and never
skips what it hasn't. Changes filtered out by `topic` still advance the cursor —
they were read and discarded, not missed.

**`operator/` is read-only to agents.** Anything under that prefix (configurable
via `messaging.operatorTopicPrefix`) is agent-readable and agent-unwritable:
`put` and `delete` both return `reason: "read-only-namespace"`. Read-only has to
mean read-only for *every* mutation — a namespace that refuses writes but allows
deletes is a speed bump, since an agent that cannot overwrite a constraint could
simply remove it. Use it for constraints you want every agent to see and none to
edit.

## What you see

Peer traffic is mirrored into the main session transcript as display-only cards.
They are session entries, which means they are persisted and **never enter the
model's context** — what a model sees is decided solely by the surface rules
above.

```text
✉ message  explore-2 → plan  · request
  ⎿  admin.ts has no auth middleware — does the plan assume one?
▤ blackboard  findings/auth-routes  · explore-2 · rev 3
  ⎿  {"missing":["requireAuth"]}
▤ blackboard  findings  · explore-2 · 4 keys
  … 37 more messaging events this minute
```

Three rules keep them readable: traffic the main session is itself an endpoint of
is suppressed (it already appears as its own tool call or its own incoming
block), writes by one author to one topic collapse into a single card with a key
count, and past twenty cards a minute the feed stops drawing and reports how many
it dropped. Traffic from another session carries that session's short id.

## Settings

All under `messaging` in `subagents.json`. Two are in `/agents → Settings`:
**Peer messaging**, which applies on the next pi session because the store and
the bus are opened once at session start, and **Message surface**, which is read
per delivery and so applies immediately. The rest are file-only. The whole block
is written back together, so keys you set by hand survive a menu toggle.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the tools exist at all |
| `scope` | `"project"` | `project` or `session` (see [Scope](#scope-who-can-talk-to-whom)) |
| `directory` | — | Override where the store lives |
| `surface` | `"ui"` | What an incoming message puts in front of the model |
| `maxWakesPerMinute` | `6` | Wake budget per agent |
| `maxHops` | `4` | Hop cap on woken agents' outbound messages |
| `messageTtlMs` | `3600000` | How long an undelivered message lives |
| `mailboxLimit` | `200` | Undelivered messages retained per agent |
| `maxWaitMs` | `120000` | Ceiling on a `wait` / `watch` block (omitted `timeout_ms` = 30 s) |
| `allowForeignMainWake` | `true` | May another session's agent wake your main? |
| `operatorTopicPrefix` | `"operator/"` | The namespace agents may read but not write |
| `notifySocket` | — | Path override, or `false` to run brokerless (polling only) |

Caps that are not settings: a message body is capped at 16 KiB, a board value at
64 KiB, and a topic at 500 keys. Consumed messages are retained 24 hours.

## When something doesn't arrive

- **`reason: "not-found"`** — the roster has no such peer. Call `op: "peers"`;
  handles are per-session, and the one you want may need qualifying.
- **`reason: "ambiguous"`** — two sessions have an agent with that handle. The
  refusal lists the qualified forms; use one.
- **`reason: "nested-child"`** — the target is owned by another agent. Ask its
  owner, or make it a top-level agent.
- **`status: "queued"` with `reason: "surface-off"`** — the recipient has
  messaging display off. It will see the message when it calls `inbox`.
- **`status: "queued"` with `reason: "wake-budget-exhausted"`** — a settled
  recipient has already been woken `maxWakesPerMinute` times. It stays queued and
  is delivered on the next wake or resume.
- **Nothing at all, and both agents are in different terminals** — check that
  `scope` is `project` in both, and that both resolve the same repository root.
- **Delivery feels slow (seconds, not instant)** — the notify socket is
  unavailable and the store is being polled. Correct, just slower; see
  `notifySocket`.

## What this is not

It is not a chat room, and not a way to hand work around behind the
orchestrator's back. The transcript cards exist so a human can see what the fleet
told itself, and the surface rules exist so no agent can force its way into
another's context. If you find yourself wanting agents to freely converse at
length, what you probably want is a [workflow](workflows.md) — deterministic
orchestration, where the structure is written down instead of negotiated.
