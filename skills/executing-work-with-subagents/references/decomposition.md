# Decomposing work into agent-sized units

The gap between a plan and an execution schedule is where most delegated work
fails. A plan task is a feature; an agent needs a unit.

## Contents

- [Why plan tasks are not delegable](#why-plan-tasks-are-not-delegable)
- [The context budget](#the-context-budget)
- [Seams to cut along](#seams-to-cut-along)
- [Sizing test](#sizing-test)
- [Micro vs macro batches](#micro-vs-macro-batches)
- [Splitting a feature: worked example](#splitting-a-feature-worked-example)
- [Discovery-first decomposition](#discovery-first-decomposition)
- [Hand-offs between units](#hand-offs-between-units)
- [When not to decompose](#when-not-to-decompose)

## Why plan tasks are not delegable

A task like *"migrate the settings store to SQLite"* carries three problems at
once:

1. **Size.** The agent must read the existing store, its callers, the schema, the
   tests, and then write all of them. That is a context window spent before it
   writes a line.
2. **Width.** It touches files other tasks also touch, so it cannot run beside
   anything.
3. **Unverifiability.** "Migrated" is not a command. There is no moment where a
   check says yes.

Delegating it as-is produces the classic failure: the agent burns its turns,
receives the wrap-up steer, and returns a `steered` partial that looks like
progress and has to be re-derived to be trusted.

Decomposition fixes all three at once, because a unit small enough to finish is
usually also narrow enough to isolate and specific enough to check.

## The context budget

Everything an agent must hold competes for one window:

```text
system prompt (+ parent prompt in append mode, + preloaded skills)
+ your brief
+ every file it reads
+ every tool result
+ its own reasoning and output
```

Practical consequences:

- **Reading dominates.** A unit that must read twenty files to change one is
  mis-cut, even if the change is small. Split the reading into a scouting unit
  and hand down its findings — a summary is a tenth the size of the sources.
- **`inherit_context` and preloaded skills are paid up front**, on every turn.
- **Compaction is a warning sign.** The widget's `⇊N` means detail has already
  been summarized away; whatever the agent read first is now a paraphrase.
- **Above ~85% context** (`(NN%)` in the widget) an agent is effectively working
  from notes about its own task.

Aim for a unit that fits comfortably, not one that just fits. The tail of a run
is where the work gets integrated, and that is exactly when the window is
fullest.

## Seams to cut along

Cut where the codebase already separates concerns; those boundaries come with
their own validation.

| Seam | Unit | Check |
|---|---|---|
| Module / package | "Port `packages/store` to the new interface" | That package's tests |
| Layer | "Update every route handler to use the new middleware" | Route tests, typecheck |
| File set with one owner | "Rewrite `src/auth/session.ts` and its test" | That test file |
| Call site class | "Update the 14 call sites of `parseConfig` in `src/cli/**`" | Typecheck |
| Data shape | "Add the `revision` column and the migration" | Migration runs, schema test |
| Question | "Which extensions register a `bash` tool?" | An answer with file:line |

Bad seams: "the first half", "the easy parts", "everything except the tests",
"the refactor, then the cleanup". None of them can be validated on their own, so
none of them can be delegated with a real acceptance criterion.

## Sizing test

Ask these five questions. A "no" means split, or merge, or scout first.

1. Can I name the one thing that is true when this is done?
2. Can I name the command or artifact that proves it?
3. Can I list the paths it may write?
4. Would a competent stranger need anything that is not in the brief?
5. Can it plausibly finish inside the turn limit without compacting?

If (4) fails, the missing context is usually a *discovery* that should be its own
upstream unit.

## Micro vs macro batches

Both are valid; they trade coordination cost against blast radius.

**Micro** — many small units, each one file or one call-site class.

- Best for: mechanical transforms, migrations across many files, per-file audits.
- Wins: high parallelism, tiny contexts, cheap models work, a failure costs one
  unit.
- Costs: integration effort, N briefs, and a real risk of inconsistency between
  units that each chose a different name for the same thing.
- Mitigation: decide the shared decisions **before** fanning out and put them in
  every brief (or on the blackboard under `operator/`). Micro-batches must be
  handed a decision, never asked to make one.

**Macro** — a few larger units, each a coherent slice.

- Best for: design-bearing work where consistency matters more than throughput.
- Wins: one agent holds the whole slice, so it stays coherent; fewer integration
  seams.
- Costs: less parallelism, bigger contexts, a failure costs more.

A good default for implementation work: **macro units, micro validation** — one
agent does a coherent slice, and each slice is gated on its own command.

## Splitting a feature: worked example

Plan task: *"Add retry with exponential backoff to the API client."*

As one unit it is unbounded: what retries, on which errors, with what interface,
and which of the 30 call sites change?

Split:

| # | Unit | Depends on | Writes | Done when |
|---|---|---|---|---|
| 1 | Find every call site of `apiFetch` and classify by whether it already handles failure | — | nothing | A list with file:line and a class per site |
| 2 | Decide the retry policy interface (signature, defaults, abort semantics) | 1 | nothing | A short design note naming the exact signature |
| 3 | Implement the retry wrapper and its unit tests | 2 | `src/api/retry.ts`, `test/retry.test.ts` | `npx vitest run test/retry.test.ts` passes |
| 4 | Adopt it at the call sites that need no behavior change | 3 | `src/api/**` (not `src/api/retry.ts`) | `npm run typecheck` clean, existing tests pass |
| 5 | Adopt it at the sites with custom failure handling | 3 | listed files only | Their tests pass |
| 6 | Review the whole change for double-retry and abort leaks | 3,4,5 | nothing | A findings report |

Units 1 and 2 are scouting and design — read-only, cheap model for 1, strong for
2. Units 4 and 5 can run in parallel *because their write scopes were made
disjoint by unit 1's classification*. Unit 6 is independent verification and must
not be the agent that wrote the code.

Note what made this work: the decomposition fell out of the discovery, not out of
imagination. That is the normal case.

## Discovery-first decomposition

You usually cannot write the unit list up front, and guessing produces units that
do not match the code. The reliable pattern:

1. **Scout inline** (or with one `Explore` agent): what exists, how many, where.
2. **Cut units from the actual list.**
3. **Fan out.**

In a workflow this is literally the first stage:

```js
const listing = await agent('List every file under src/routes/. One path per line, nothing else.')
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
log(`auditing ${files.length} route files`)
```

Do not create downstream tasks whose contract depends on findings you do not
have. Create them once the discovery reports back.

## Hand-offs between units

A unit that produces something a later unit needs must say **what** it hands over
and **where**:

- Small results: in the result text, in the shape the next brief expects.
- Larger results: a file at a stated path, and the path in the result.
- Facts many units need: the blackboard, with the topic and key convention stated
  in every brief.
- Inside a workflow: the return value of the stage, which the next stage's prompt
  interpolates — use `schema` when the next stage needs fields rather than prose.

Completion alone carries nothing. "Task 3 is done" tells task 4 neither the
interface that was chosen nor where to find it.

## When not to decompose

- The whole job fits one agent comfortably. Splitting adds briefs, spawns and
  integration for nothing.
- The parts are so coupled that each unit would need the others' context anyway —
  that is one unit, and possibly one you should do yourself.
- The work is exploratory and the shape will change as you learn. Scout first,
  decompose after.
- It is a single decision. Decisions are cheap to make and expensive to
  coordinate; make it, then delegate the execution.
