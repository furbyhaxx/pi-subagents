---
name: coordinating-subagents
description: Run a fleet of pi subagents as a team lead — writing briefs a cold agent can execute, choosing background vs foreground, naming and addressing agents, steering mid-run, stopping and resuming, reading transcripts instead of trusting summaries, enforcing evidence discipline, and using AgentMessage/Blackboard so findings do not all route through you. Use this whenever work is handed to one or more subagents, whenever several agents are running at once, when an agent's claim has to be trusted or checked, when a delegated run has gone off the rails, or when someone says "have agents do this", "run these in parallel", "check on the agents" or "ask the agent to also ...".
---

# Coordinating subagents

You are the team lead. Your job is not to do the work and not to watch it happen
— it is to write briefs that can be executed cold, to keep the fleet from
colliding, and to refuse to believe a result you have no evidence for.

Splitting work into agent-sized units first is
[`executing-work-with-subagents`](../executing-work-with-subagents/SKILL.md).
Configuring the agent types themselves is
[`authoring-subagents`](../authoring-subagents/SKILL.md).

## The three failures

Nearly every bad fan-out is one of these:

1. **Under-briefing.** The agent cannot see your conversation, does not know what
   you already ruled out, and cannot ask. A terse command produces shallow work.
2. **Racing.** You launch a background agent and then talk about its results, or
   poll it with sleeps, or start a second agent that writes the same files.
3. **Believing the summary.** An agent's final message describes what it
   *intended*. It is not evidence that anything works.

Everything below is machinery for avoiding those three.

## Delegate or do it yourself

| Situation | Do |
|---|---|
| The target is already known (a path, a symbol) | `read`/`grep` yourself — a subagent costs a process and a context |
| Open-ended search across the repo | `Explore` |
| Work that would flood your context with output you do not need to keep | Delegate, and ask for a summary |
| Several independent investigations | Delegate all of them in **one message** so they run concurrently |
| Work needing judgement you already have loaded | Do it yourself; briefing costs more than doing |
| The number of agents depends on what a first agent finds | `SubagentWorkflow`, not a chain of `Agent` calls |

Delegation buys two things — parallelism and context protection. If a task buys
neither, it is cheaper to do it.

## The brief

An agent gets exactly what you write. Brief it like a competent colleague who
just walked in: what we are trying to achieve, what is already known, what is out
of bounds, and what "done" looks like.

```text
Goal:        why this matters, not just what to do
Context:     what is already established, ruled out, or tried
Scope:       files/dirs it may touch; what it must not touch
Method:      only the steps that are non-obvious or that it would skip
Done when:   the command that must pass, or the artifact that must exist
Report:      the exact shape you need back, and how long
```

Two rules that do most of the work:

- **Lookups get the command; investigations get the question.** Prescribed steps
  become dead weight the moment the premise is wrong.
- **Never delegate understanding.** "Based on your findings, fix the bug" pushes
  the synthesis onto an agent that has less context than you. Name the file, the
  line, and the change.

Full anatomy, worked examples and common brief defects:
[`references/delegation-briefs.md`](references/delegation-briefs.md).

## Launching

- **Background is the default and usually right.** The call returns an ID
  immediately and you are notified on completion. Use `run_in_background: false`
  only when your very next action depends on the result and nothing else could
  usefully happen meanwhile.
- **Launch independent agents in one message.** Several `Agent` calls in a single
  assistant turn start concurrently; spread across turns they serialize.
- **Name agents you will have to talk about**: `name: "auth-audit"` makes it
  `@auth-audit` for you and a handle for `steer_subagent` /
  `get_subagent_result`. Worth it as soon as two agents share a type.
- **`description` is 3-5 words** and is what you will see in the widget and
  FleetView. Make the rows distinguishable.
- **Do not pass `model`** unless you are overriding a configured agent
  deliberately — an explicit model replaces the agent's whole fallback list.

## While they run

**Do not poll.** No sleeps, no repeated `get_subagent_result`, no "let me check
on it". Completion arrives as a notification in a later turn. Continue with
independent work or hand control back.

**Never predict a result.** Until the notification lands you know nothing about
what an agent found. Do not summarize, pre-write, or reason from imagined
findings — not in prose, not in a table, not in a plan. If asked before it lands,
report status.

**Steer instead of restarting.** `steer_subagent` (or `@handle message`) injects
a message after the current tool call. Use it the moment you see an agent
working from a wrong premise — a restart throws away everything it has learned,
and its context is the expensive part.

**Stop when the premise is dead**, not when the agent is merely slow. `x` twice
in `/agents` or the viewer; a stopped agent still reports partial output.

Watching, steering, stopping, resuming and what each costs:
[`references/supervision-and-steering.md`](references/supervision-and-steering.md).

## Evidence discipline

Treat every delegated claim as unverified until you have a reason not to.

- **Read the diff, not the summary.** When an agent wrote code, look at what
  actually changed before reporting it as done.
- **Prefer a command to an opinion.** A test suite, a typecheck, a build is a
  stronger signal than another model's review — and in a workflow, `gate:` makes
  it structural: a non-zero exit fails the agent.
- **A partial result is not a result.** `steered`, `aborted` and `stopped`
  statuses mean the agent ran out of road. Its answer covers whatever it had.
- **Independent verification means independent.** An agent asked to check its own
  work confirms it. Give the claim to a fresh agent with the evidence and ask it
  to *refute*.
- **Quote nothing you did not measure.** No invented test counts, timings, or
  "no behavior change" you did not run.

How to structure verification, when to use a refuter panel, and what to do with
disagreement: [`references/evidence-discipline.md`](references/evidence-discipline.md).

## Keeping the fleet coherent

- **Write scopes must be disjoint.** Nothing in this extension isolates agents
  from each other in the same checkout. Two agents editing one file is your bug,
  not theirs. If they must share, serialize them or give each a branch.
- **Concurrency is 10 background agents** by default; the rest queue. A fan-out
  of thirty is fine, it just drains.
- **Join mode shapes your notifications.** `smart` (default) consolidates agents
  spawned in the same turn into one notification; `async` reports each
  separately, which is what you want when results need handling as they land.
- **Let agents talk to each other** when a fan-out would otherwise rediscover the
  same fact ten times: `Blackboard` for durable findings, `AgentMessage` for a
  direct question. Put the constraints you do not want edited under `operator/`.
  See [`references/peer-messaging.md`](references/peer-messaging.md).
- **Watch context, not just time.** The widget's `(NN%)` and `⇊N` show an agent
  filling its window and compacting. An agent above ~85% is losing the early part
  of its task; that is a decomposition problem, not a model problem.

## When a run goes wrong

| Symptom | Read this way | Action |
|---|---|---|
| Agent asks a question in its final answer | It had no user to ask; the brief was ambiguous | Answer it via resume (`@handle`), and fix the brief for next time |
| `steered` status | Hit `max_turns`, wrapped up | Treat the answer as partial; split the task |
| `aborted` | Blew through the grace period | Almost always too-large scope |
| Result contradicts another agent's | Both are claims | Verify with a command, or a third agent given both |
| Agent edited files outside its scope | Scope was prose, not enforcement | Use a worktree or branch next time |
| Two agents both claim to have fixed it | They shared a write scope | Inspect the tree; re-run one on a clean base |
| Nothing arrives for a long time | It may be queued behind `maxConcurrent` | `/agents → Running agents` shows `queued` |

## Reporting back

When you relay a fleet's work to the user:

- Say what was verified and how, and what was merely claimed.
- Name the agents that failed or were stopped, not just the successes.
- Give the paths of artifacts and transcripts rather than pasting everything.
- Keep it short. You are the compression layer; that is most of your value.

## References

| File | Read it when |
|---|---|
| [`references/delegation-briefs.md`](references/delegation-briefs.md) | Writing the prompt for a delegated task |
| [`references/supervision-and-steering.md`](references/supervision-and-steering.md) | An agent is running and you need to watch, redirect, stop or resume it |
| [`references/evidence-discipline.md`](references/evidence-discipline.md) | Deciding whether to believe a result |
| [`references/peer-messaging.md`](references/peer-messaging.md) | Several agents need to share findings without routing through you |
