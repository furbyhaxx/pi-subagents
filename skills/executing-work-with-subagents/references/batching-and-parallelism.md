# Batching, scheduling and parallelism

Once you have units, the question is what runs together. The answer is decided by
data dependencies and write scopes — not by how independent the units feel.

## Contents

- [The scheduling rule](#the-scheduling-rule)
- [Building the dependency graph](#building-the-dependency-graph)
- [Write-scope discipline](#write-scope-discipline)
- [Batch shapes](#batch-shapes)
- [Launching a batch](#launching-a-batch)
- [Barriers cost wall-clock](#barriers-cost-wall-clock)
- [Sizing the fan-out](#sizing-the-fan-out)
- [Integration and the batch boundary](#integration-and-the-batch-boundary)
- [Failure handling](#failure-handling)
- [Using the task tools](#using-the-task-tools)

## The scheduling rule

Two units may run concurrently only if **both** hold:

1. Neither reads what the other writes.
2. Their write scopes do not overlap — not the same file, and not two files that
   must change together to stay consistent.

Readiness (prerequisites satisfied) says a unit *may* start. It says nothing
about whether it is safe beside its sibling. Nothing in this extension isolates
agents from each other in a shared checkout: no locking, no conflict detection,
no per-agent view of the tree. Two agents editing one file is a silent
last-writer-wins.

## Building the dependency graph

For each unit, write down: what it reads, what it writes, what it needs to know
that another unit produces. Then:

- An edge exists when B needs A's **output** — findings, an interface decision, a
  file A creates.
- An edge does **not** exist just because A "comes first" conceptually. Edges you
  add for tidiness serialize work that could have overlapped.
- Two units with overlapping writes are not an edge problem, they are a *scope*
  problem: merge them, split differently, or give them separate branches.

Keep the graph shallow. Deep chains mean every stage waits on the slowest member
of the previous one; wide graphs finish in the time of the longest single chain.

## Write-scope discipline

State the write scope in every brief, in paths:

> You may edit `src/api/**` except `src/api/retry.ts`. Do not touch tests; if a
> test is wrong, report it. Do not commit.

Then enforce it where it matters:

| Risk | Enforcement |
|---|---|
| Low — read-only agents | The brief plus a read-only agent type |
| Medium — one writer at a time | Serialize; run the check suite after |
| High — parallel writers on related code | A `branch` workspace per agent, merged deliberately |
| Speculative — may be thrown away | `isolation: "worktree"` (disposable) |

Remember that scope in a prompt is a directive, not a sandbox: an agent with
`bash` can write anywhere. If the blast radius matters, use isolation and a
restricted tool set, not stronger wording.

## Batch shapes

**Fan-out (map).** N independent units, same shape, disjoint scopes. The
workhorse: per-file audits, per-module migrations, per-question research.

**Fan-out then reduce.** N units, then one agent that synthesizes. The synthesis
agent is the only one that needs all results, so it is the only barrier.

**Pipeline.** Each item flows through stages independently (find → verify → fix).
No barrier: item A can be in stage 3 while item B is in stage 1.

**Panel.** The same input to several agents with *different lenses*
(correctness, security, performance), then a reconciliation. Use when a thing can
fail in several unrelated ways.

**Loop-until-dry.** Keep spawning finders until K consecutive rounds return
nothing new. For discovery of unknown size, where a fixed count always misses the
tail. Deduplicate against everything seen, not against what survived judging, or
it never converges.

**Sequential chain.** Each unit needs the previous one's files. Same branch, one
writer, in order. Slow but sometimes the only correct shape.

## Launching a batch

- Put every independent `Agent` call of a batch in **one message**. Calls in
  separate turns serialize.
- Background by default; a blocking call only when the next thing you do depends
  on it and nothing else can proceed.
- Give each agent a `name` when several share a type, so the widget, FleetView
  and `@handle` are readable.
- Choose the join mode deliberately: `smart` (default) consolidates one turn's
  agents into a single notification — good when the batch is one unit of thought;
  `async` reports each separately — good when you want to act as results land.
- Do not poll. Continue with independent work; the notifications arrive.

## Barriers cost wall-clock

A barrier is `parallel()` in a workflow, or "wait for all of these before doing
anything". It is justified only when the next step genuinely needs **every**
prior result together:

- deduplicating or merging across the whole result set;
- deciding whether to continue at all ("zero findings → skip verification");
- a prompt that compares one result against all the others.

It is **not** justified by needing to flatten, map or filter (do that inside a
stage), by the stages feeling conceptually separate, or by the code reading more
neatly. If five agents run and the slowest takes three times the fastest, a
barrier wastes two-thirds of the fast agents' time.

In plain `Agent` calls the equivalent mistake is waiting for a whole batch before
launching work that only depended on one member of it.

## Sizing the fan-out

- Background concurrency is `maxConcurrent` (default 10); the excess queues and
  drains. Launching 30 is fine.
- A workflow bounds itself at `max(1, min(16, cpus - 2))` and is capped at 1000
  agents per run, 4096 items per `parallel`/`pipeline` call.
- The real limits are cost and your ability to review: 20 agents produce 20
  results you are responsible for. Unreviewed parallelism is not throughput.
- Scale the shape to the request. "Find any bugs" is a few finders and one
  verification pass; "audit this thoroughly" earns a larger finder pool and a
  3-5 vote adversarial stage.
- If you bound coverage (top-N, sampling, no retries), **say so**. Silent
  truncation reads as completeness.

## Integration and the batch boundary

Units that each pass can still fail together. After every batch that wrote code:

1. Run the project's own check command once (`npm run check`, the test suite, the
   build). Not per agent — at the boundary.
2. `git diff` / `git status` and read what actually changed. Look for two agents
   solving the same problem differently, duplicated helpers, and edits outside
   the stated scopes.
3. Reconcile naming and shape decisions the units made independently. This is the
   cost of micro-batching; budget for it.
4. Only then move to the next batch.

If the batch used branches, integrate them one at a time and re-run the check
after each merge; a merge that is clean textually is not necessarily clean
semantically.

## Failure handling

| Failure | Meaning | Response |
|---|---|---|
| One unit fails, others pass | Usually a bad brief or a mis-cut unit | Fix the brief, re-run that unit alone |
| `steered` / `aborted` | Ran out of turns — unit too big | Split it; do not just raise `max_turns` |
| Several units fail the same way | Systematic: a wrong shared assumption | Stop the batch, fix the assumption, re-run |
| Results conflict | Overlapping scope, or different premises | Check the tree; re-run one on a clean base |
| Workflow `agent()` returned `null` | Terminal failure or an inspector skip — indistinguishable | Filter, and log what was dropped |

A failing unit should not silently drop out of a fan-out. Note it, and say in the
final report which units did not complete.

## Using the task tools

When the batch is large enough that you will lose track — or when the work must
survive a compaction or a new session — record units as tasks (`TaskCreate`)
rather than holding them in your head:

- One task per unit, with the full briefing in the description: goal, scope,
  acceptance criteria, hand-off.
- `blockedBy` only for real hand-offs, using IDs already returned by earlier
  calls.
- Group prerequisites (`TaskGroupCreate`) are an all-to-all barrier; prefer
  per-task edges unless you really want a phase gate.
- Launch non-conflicting ready tasks in one `TaskExecute` call. It provides **no
  isolation** — the disjoint-write-scope rule applies exactly as it does to
  `Agent` calls.
- Only mark a task completed when its acceptance criterion actually passed, and
  record what downstream tasks need in its result.
