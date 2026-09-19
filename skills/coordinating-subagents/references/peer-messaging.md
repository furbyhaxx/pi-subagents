# Peer messaging and the shared blackboard

By default every fact an agent learns travels up to whoever spawned it and back
down again — so a fan-out of ten agents auditing ten files rediscovers the same
fact ten times, and you pay for all ten. `AgentMessage` and `Blackboard` let the
fleet share directly. Full guide: the extension's `docs/messaging.md`.

## Contents

- [When to use which](#when-to-use-which)
- [Scope and addressing](#scope-and-addressing)
- [What a message costs the recipient](#what-a-message-costs-the-recipient)
- [The blackboard](#the-blackboard)
- [The operator namespace](#the-operator-namespace)
- [Designing a fan-out around the board](#designing-a-fan-out-around-the-board)
- [Receipts and failures](#receipts-and-failures)
- [What this is not](#what-this-is-not)

## When to use which

| Need | Use |
|---|---|
| A durable fact several agents will want | `Blackboard put` |
| A question for one specific agent | `AgentMessage send` |
| "Has anyone already done X?" | `Blackboard get` / `list` |
| Wait for another agent's finding before continuing | `Blackboard watch`, or `AgentMessage wait` |
| Tell every live subagent something | `AgentMessage broadcast` (live subagents only, never wakes anyone) |
| Constraints no agent may edit | `Blackboard` under `operator/` |
| Deterministic multi-stage coordination | Not messaging — a `SubagentWorkflow` |

Rule of thumb: **the board for facts, messages for questions, a workflow for
structure.** If agents need to negotiate at length to get the work done, the
structure was missing, and a script would have been cheaper and more reliable.

## Scope and addressing

Scope defaults to `project`: every pi session in the same repository shares one
roster, one store and one bus, so agents in two terminals are peers. `session`
scope limits it to agents this session started.

| Participant | Addressable as |
|---|---|
| Top-level subagent | its agent id, its type handle (`explore-2`), or the `name` you gave it |
| A main session | `main:<session-id>`, `main-<short-id>`, or its session name |
| Nested child | not addressable — its owner speaks for it |

`to` resolves as: exact id → a handle in the caller's own session → a
scope-unique handle → otherwise refused as `ambiguous` with qualified candidates
(`explore@9f3a1c`). Name your agents at spawn and this rarely bites.

Agents with `isolated: true` get neither tool.

## What a message costs the recipient

This is the only mechanism that spends another model's context without it asking,
so the setting belongs to the **reader** (`messaging.surface`, or
`messaging_surface` per agent) and a sender never decides:

| Surface | Recipient gets |
|---|---|
| `off` | Nothing until it calls `inbox` |
| `ui` (default) | One line at the next turn boundary: who wrote, how many unread |
| `context` | The full attributed body |

Practical consequences for a team lead:

- Assume a peer message costs the recipient about a line. If the content matters,
  put it on the **board** and send a one-line pointer.
- Pulling beats pushing: `inbox` and `watch` are one cheap call each and land
  exactly what the agent asked for, when it chose.
- Messages arriving between turn boundaries are coalesced into one notice. Under
  `context`, at most ten bodies per batch; the rest ride the next boundary.
- A message to a finished-but-resumable agent **wakes it for a turn**, bounded by
  `maxWakesPerMinute` (6) and a hop cap (`maxHops`, 4). Do not use messaging to
  keep a settled fleet alive.

## The blackboard

Entries are `topic` + `key` with a value, an author, a revision and timestamps.

```jsonc
{ "op": "put",   "topic": "findings", "key": "auth-routes", "value": {"missing": ["requireAuth"]} }
{ "op": "get",   "topic": "findings", "key": "auth-routes" }
{ "op": "list",  "topic": "findings" }
{ "op": "watch", "topic": "findings", "timeout_ms": 30000 }
```

- **Authorship is stamped, never submitted.** There is no `author` parameter, so
  no agent can sign as another.
- **Optimistic concurrency:** `if_revision` applies the write only at that
  revision (`0` = must not exist). A conflict returns the current value, author
  and revision as an *answer* — the agent can merge, retry or defer instead of
  failing.
- **`watch` starts from now.** Omit `since` to see only what happens next; `0`
  replays the log. Every result carries a `cursor` for the next call.
- Caps: 64 KiB per value, 500 keys per topic, 16 KiB per message.

## The operator namespace

Anything under `operator/` (configurable) is agent-readable and
agent-unwritable — both `put` and `delete` are refused. Use it for constraints
you want every agent to see and none to edit:

```jsonc
{ "op": "put", "topic": "operator/constraints", "key": "release",
  "value": "Do not touch src/legacy/**. Do not commit. Node 20 only." }
```

Write these from `/agents → Blackboard` (the human-owned path) and tell agents in
their brief to read them. An agent that happens to be *handled* `operator` is
recorded by its id instead, so naming an agent after the human buys it nothing.

## Designing a fan-out around the board

A pattern that works for repo-wide audits:

1. Before spawning, put the shared constraints under `operator/constraints`.
2. In each brief, say: read `operator/constraints` first; publish findings to
   `findings/<file>`; before starting, `get` your own key — if it exists, another
   agent already covered it, so report that and stop.
3. Give every agent the same topic naming convention **explicitly**. Parallel
   agents left to invent key names will each invent a different one, and the
   board becomes unqueryable.
4. Collect with one `list` at the end rather than reading ten completion
   notifications.

The board is also how a long fan-out survives its own failures: an agent that
dies after publishing has still contributed.

## Receipts and failures

A receipt describes **delivery**, never the reply (a reply is a separate message
carrying the same `correlationId`).

| Status / reason | Meaning |
|---|---|
| `injected` | In the recipient's context at its next turn |
| `woken` | The recipient was settled and has been resumed for a turn |
| `queued` + `surface-off` | Recipient has display off; it will see it on `inbox` |
| `queued` + `active-wait` | Recipient is already blocked in `wait`; delivered after |
| `queued` + `wake-budget-exhausted` | Too many wakes this minute |
| `accepted` | Another live pi process owns the recipient and will deliver |
| `failed` | Recipient is gone |
| refused + `not-found` / `ambiguous` / `nested-child` | Addressing problem — call `peers` |

Nothing arriving at all between two terminals usually means the two sessions
resolved different repository roots, or one is on `session` scope.

Delivery that feels slow (seconds) means the notify socket is unavailable and the
store is being polled. That is correct behavior, not a fault: SQLite is the only
source of truth, and losing the socket costs latency, never a message.

## What this is not

It is not a chat room, and not a way to route work around you. Traffic is
mirrored into the transcript as display-only cards so a human can see what the
fleet told itself — those cards never enter any model's context.

If you find yourself wanting agents to converse at length to get a job done, the
job needed structure: write a `SubagentWorkflow`, where the coordination is in
the script instead of being negotiated at runtime.
