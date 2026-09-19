---
name: executing-work-with-subagents
description: Turn real work into subagent-executable batches — splitting plan or feature tasks into units that fit one agent's context, deciding what runs sequentially vs in parallel, keeping write scopes disjoint so parallel agents cannot collide, choosing disposable worktrees vs retained branches vs the shared checkout, gating each batch on a command that must pass, and choosing between Agent calls and SubagentWorkflow. Use this whenever a multi-step implementation, migration, refactor, audit, review or research job is about to be delegated, when a plan's tasks are too large for one agent, when agents might write the same files, or when someone says "split this up", "do these in parallel", "use worktrees" or "work through this plan".
---

# Executing work with subagents

A plan is not an execution schedule. Plan tasks are *features* — "add retry to
the API client", "migrate the store to SQLite" — and a feature is usually bigger
than one agent's context and wider than one agent's write scope. This skill is
about the translation: from work, to batches, to agents that can actually finish
and be checked.

Writing the brief for each unit and supervising the run is
[`coordinating-subagents`](../coordinating-subagents/SKILL.md). Configuring the
agent types is [`authoring-subagents`](../authoring-subagents/SKILL.md).

## The pipeline

```text
work  →  scout  →  units  →  batches  →  execute  →  validate  →  integrate
```

1. **Scout** inline first. List the files, find the call sites, read the shape of
   the problem. You cannot size units for a work-list you do not have, and
   discovery is cheap compared to a mis-sized fan-out.
2. **Cut units** that each produce one checkable outcome.
3. **Group units into batches** by dependency and by write scope.
4. **Execute** a batch: parallel `Agent` calls, or a workflow when the count is
   discovered at run time.
5. **Validate** each unit against its own criterion — ideally a command.
6. **Integrate** and re-validate the whole, because units that each pass can
   still fail together. Work done in a worktree or on a branch is integrated only
   once it is reviewed, merged back, re-checked in the main tree, and the copy is
   removed.

Do not skip step 1. A hybrid approach — scout inline, then fan out over what you
found — beats both "plan everything up front" and "delegate the whole feature".

## Cutting a unit

A unit is right-sized when all of these hold:

- **One outcome.** It is done when one identifiable thing is true.
- **It fits one context.** Everything the agent must read, plus what it writes,
  plus room to think. If it needs to read twenty files to change one, it is too
  big — split the reading out as a scouting unit and hand its findings down.
- **It is checkable without you.** A command, a file that must exist, an answer
  to a specific question.
- **Its write scope is nameable.** You can list the paths it may touch.
- **It is briefable cold.** Everything it needs fits in a brief; it does not
  depend on having watched the conversation.

Cut across seams the codebase already has — module, layer, file, route, package.
Cutting across an artificial line ("the first half of the refactor") produces
units that cannot be validated independently, which defeats the point.

**Do not over-cut.** One task per file is bookkeeping, not decomposition: every
split costs a brief, a spawn, a context, and an integration step. A coherent
multi-file change is one unit. Split when the second half *depends on what the
first half discovers*, or when the two halves are independently checkable.

Sizing heuristics, seams to cut along, and how to split a plan task:
[`references/decomposition.md`](references/decomposition.md).

## Sequential or parallel

Parallel is not the default — **disjoint** is.

Two units may run at the same time only when neither reads what the other
writes, and their write scopes do not overlap. Nothing in this extension
isolates agents from each other in a shared checkout; readiness means a unit may
start, not that it is safe to run beside another one.

| Relationship | Schedule |
|---|---|
| Independent, disjoint writes | Parallel — launch in one message |
| B needs A's *findings* | Sequential, or one pipeline where A's result feeds B's prompt |
| B needs A's *files* | Sequential on the same branch, or A commits and B branches from it |
| Both write the same file | Serialize, or give each a branch and merge deliberately |
| Same files, different concerns (review + fix) | Sequential: fix, then review the result |

When you genuinely need overlapping writes in parallel, give each agent its own
`branch` workspace and integrate yourself. That converts a race into a merge,
which is a problem you can see.

Batch shapes, dependency graphs, fan-out patterns and what a barrier costs:
[`references/batching-and-parallelism.md`](references/batching-and-parallelism.md).

## Where the work happens

| Mode | Use when | Cost |
|---|---|---|
| Shared checkout (default) | Read-only work, or a single writer | None; no protection either |
| `isolation: "worktree"` | Speculative or risky writes you may throw away | Copy setup + disk; changes preserved on a `pi-agent-*` branch, worktree removed |
| `branch: "feat/x"` | Multi-step work on one line, reused across calls | Retained workspace; nothing auto-commits or removes it |

**Isolation is not free.** Every worktree is a full checkout: seconds to minutes
of setup and a copy of the repository on disk, per agent. It does not remove a
conflict either — it converts a race into a merge, which is a better problem but
still a problem you have to work. Pay for it when writes would genuinely collide,
when the work may be thrown away, or when the main checkout must stay usable;
otherwise a shared checkout with one writer is faster and simpler.

Work in a worktree is not done when the agent finishes — it is done when it has
been reviewed, merged back, and the copy is off your disk. See
[integrating a workspace](references/worktrees-and-branches.md#reviewing-merging-and-cleaning-up).

Three rules that cause most of the pain when ignored:

- A fresh worktree **does not** contain the caller's uncommitted or staged
  changes. Never review the working-tree diff from inside one.
- `branch` is an argument you pass, not a request for the agent to switch
  branches. Agents that improvise git setup make messes.
- One writer per repository/branch. Contention fails fast rather than queueing;
  never point two parallel agents at the same branch.

Full semantics, lease behavior, monorepo scope and cleanup:
[`references/worktrees-and-branches.md`](references/worktrees-and-branches.md).

## Agent calls or a workflow

| Situation | Tool |
|---|---|
| One task, or a handful you can name now | `Agent` calls in one message |
| The number of agents depends on what a first agent finds | `SubagentWorkflow` |
| Work flows through stages (find → verify → fix) | `SubagentWorkflow` (`pipeline`) |
| Findings must be independently verified before you believe them | `SubagentWorkflow` |
| Success is a command exiting zero | `SubagentWorkflow` with `gate:` |
| You want structured objects back, not prose | `SubagentWorkflow` with `schema:` |

A workflow is a deterministic script: `agent()`, `pipeline()`, `parallel()`,
`phase()`, `log()`, `args`. Prefer `pipeline` — it has no barrier between stages,
so one item can be in stage 3 while another is in stage 1. `parallel` is a
barrier and idles every fast agent until the slowest finishes; it is earned only
when a stage genuinely needs every prior result at once.

Scripts, options, gates, resume journals and recipes:
[`references/workflow-execution.md`](references/workflow-execution.md).

## Validate every batch

A batch that is not validated is a batch you will re-do.

- Give each unit a **command** as its acceptance criterion where one exists. In a
  workflow, make it a `gate:` so it is enforced rather than requested.
- Validate **at the batch boundary too**: units that each pass can fail together
  (two agents both adding the same import, a shared type edited twice).
- After a fan-out into a shared checkout, run the project's own check suite once
  at the end.
- Read the diff. An agent's summary is a claim; see the coordinating skill's
  evidence discipline reference.

## New agent, resume, or steer

| Want | Do |
|---|---|
| A different job | New agent — a resumed one drags its old context into the new task |
| A follow-up on the same material | `resume` (or `@handle`) — keeps the context you already paid for |
| To correct a running agent | `steer_subagent` — far cheaper than restarting |
| The same files, different concern | New agent on the same `branch` — shares files, not conversation |
| To retry after a failed gate | `resume` the same label, then a **fresh gated call** to re-verify (resume does not inherit a gate) |

Spawn a new agent when the context you would be reusing is mostly irrelevant to
the next job; that irrelevant context is not free, and it biases the new work.

## Anti-patterns

| Pattern | Why it fails |
|---|---|
| Delegating a plan task verbatim | Feature-sized; the agent runs out of context and returns a `steered` partial |
| Merging an agent branch without reading it | The preservation commit bypassed your hooks; nothing has validated it |
| Leaving worktrees on disk after merging | Copies accumulate silently, and a stale one gets reused or reviewed by mistake |
| Fanning out before scouting | You cannot size or scope units for a work-list you have not seen |
| Parallel agents in one checkout writing related files | Lost edits, half-applied changes, no way to attribute them |
| One task per file | Brief + spawn + integrate overhead exceeds the work |
| A worktree per agent by reflex | Setup time and disk per agent; only worth it when writes would actually collide |
| Asking an agent to create a worktree or switch branches | Pass `branch`/`isolation` instead |
| A workflow for a single task | A script's value is loops, stages and verification |
| Accepting "done" without a check | The most expensive shortcut available |
| Chaining stages with `parallel` barriers | Wastes the fast agents' time for nothing |

## References

| File | Read it when |
|---|---|
| [`references/decomposition.md`](references/decomposition.md) | Turning a feature/plan task into units |
| [`references/batching-and-parallelism.md`](references/batching-and-parallelism.md) | Scheduling units, avoiding collisions, fan-out shapes |
| [`references/worktrees-and-branches.md`](references/worktrees-and-branches.md) | Choosing and using isolation |
| [`references/workflow-execution.md`](references/workflow-execution.md) | Writing or running a `SubagentWorkflow` |
