# Writing a delegation brief

The brief is the entire world an agent has. It cannot see the conversation, does
not know what you tried, cannot ask a follow-up question, and will not tell you
it was confused — it will guess and proceed.

## Contents

- [The template](#the-template)
- [Why each section exists](#why-each-section-exists)
- [Lookups vs investigations](#lookups-vs-investigations)
- [Never delegate understanding](#never-delegate-understanding)
- [Worked examples](#worked-examples)
- [Brief defects and their symptoms](#brief-defects-and-their-symptoms)
- [Briefing by agent type](#briefing-by-agent-type)
- [Length and cost](#length-and-cost)

## The template

```text
Goal
  What we are trying to accomplish and why it matters. One or two sentences.

Context
  What is already established, already ruled out, already tried — and the
  conclusions you reached, not just the steps.

Scope
  Paths it may read and paths it may write. What is explicitly out of bounds.
  Whether it may install, run migrations, commit, push.

Method
  Only the steps that are non-obvious, or that this model reliably skips.
  With reasons. Omit entirely when the agent should decide the approach.

Done when
  The command that must exit zero, the file that must exist, the question that
  must be answered. Observable, not "when it looks right".

Report
  The exact shape you need back, and a length bound.
```

Not every brief needs all six. A lookup is Goal + Report. An implementation task
needs all of them.

## Why each section exists

**Goal** lets the agent make judgement calls you did not anticipate. Without the
*why*, it optimizes the literal instruction — which is how you get a
technically-correct change that misses the point.

**Context** is the expensive part to reconstruct. Every fact you withhold, the
agent re-derives with tool calls, in its own context, slowly. "The bug is not in
the parser — I already checked `tokenize()` and the tokens are correct" saves ten
turns.

**Scope** is the only thing standing between a parallel fan-out and two agents
editing the same file. State it even when it feels obvious. Note that scope in a
prompt is a *directive*, not enforcement — for enforcement use a worktree or a
branch.

**Method** is where over-briefing does damage. Prescribed steps become dead
weight when the premise turns out to be wrong, and a model following a recipe
stops noticing that the recipe does not fit. Include a step only when you know it
is non-obvious or when you know the model skips it.

**Done when** is what converts a claim into a check. If you can name a command,
name it — and in a workflow, make it a `gate:` so it is enforced rather than
requested.

**Report** decides whether the result is usable. An agent that does not know who
reads its output writes a essay. Say "under 200 words", "one line per file", or
paste the literal template.

## Lookups vs investigations

**A lookup** has a known answer and a known method. Hand over the command.

> Run `rg -n "subagents:rpc:" src/ --type ts` and report every channel name with
> its file and line. Nothing else.

**An investigation** has an unknown answer and possibly a wrong premise. Hand
over the *question*, plus what you already know, and let the agent choose how.

> Background agents sometimes report completion twice. I have ruled out the group
> join manager — the duplicate appears even with `joinMode: async`. Find out
> where the second notification originates. Start from `agent-manager.ts`, but do
> not assume the bug is there.

Prescribing steps for an investigation is the single most common way to get a
confidently wrong answer: the agent executes your plan, the plan was based on a
wrong premise, and it reports success.

## Never delegate understanding

These phrases push synthesis onto an agent with less context than you:

- "Based on your findings, fix the bug."
- "Based on the research, implement it."
- "Do whatever is needed to make this work."
- "Review the code and improve it."

Write the brief so it proves you understood the problem. Name the file, the
line, the symbol, the change, and the check. If you *cannot* name them, you are
not ready to delegate the fix — delegate the diagnosis first, read the result,
then write the second brief yourself.

## Worked examples

**Poor:**

> Look at the auth code and fix the session bug.

Nothing here is actionable: no path, no symptom, no reproduction, no definition
of fixed. The agent will read broadly, guess a defect, and change something.

**Better:**

> **Goal** — Sessions are being dropped on reconnect, so users get logged out
> when their laptop wakes. Fix the cause, not the symptom.
>
> **Context** — Reproduced with `npm run test:integration -- session-resume`
> (currently failing). The token itself is valid on reconnect; I verified that by
> logging it in `src/auth/session.ts:118`. So this is not token expiry.
>
> **Scope** — You may edit `src/auth/**`. Do not touch `src/api/**` or the tests;
> if a test is wrong, report it instead of changing it. Do not commit.
>
> **Done when** — `npm run test:integration -- session-resume` passes and
> `npm run typecheck` is clean.
>
> **Report** — What the root cause was, the files you changed, and the test
> output. Under 200 words.

**A research brief:**

> **Goal** — I am choosing between two libraries for the retry layer and need the
> actual failure semantics, not marketing copy.
>
> **Context** — We need per-attempt jitter and the ability to abort mid-backoff
> through an AbortSignal. I have already read both READMEs; they both claim
> support, and the READMEs do not say what happens to an in-flight timer.
>
> **Method** — Read the source, not the docs. Clone or fetch the repos.
>
> **Done when** — You can point at the line in each library that handles abort
> during a backoff wait.
>
> **Report** — A table: library, version, file:line, actual behavior on abort,
> and whether jitter is per-attempt or global. Then one paragraph on which you
> would pick and why. Under 400 words.

## Brief defects and their symptoms

| Symptom in the result | Defect |
|---|---|
| Agent asks a question in its final message | Ambiguity with no stated fallback. Add "if X is unclear, assume Y and say so." |
| Answer is an essay | No Report section, or no length bound |
| Agent changed unrelated files | No Scope section |
| Agent re-derived something you already knew | No Context section |
| Agent followed a wrong plan to completion | Over-specified Method on an investigation |
| Agent reports "done" with nothing verified | No Done-when, or one that is not a command |
| Agent stops early, says it needs more information | Missing context it had no way to obtain |
| Two parallel agents produced conflicting edits | Overlapping write scopes |

## Briefing by agent type

- **`Explore`** — state the breadth (`quick`, `medium`, `very thorough`) and what
  a hit looks like. It reads excerpts, so do not ask it for review or
  cross-file consistency analysis; ask it for locations.
- **`Plan`** — give it the constraint set and the things that must not change. It
  cannot edit, so ask for sequencing and critical files, not code.
- **`general-purpose`** — inherits the parent's system prompt, so project
  conventions are already there. Do not restate them; do state what is different
  about *this* task.
- **A custom type** — its role is in its own prompt. Brief only the run: target,
  context, scope, done-when.
- **A workflow child** — its final message *is* the return value, interpolated
  into the next stage. Ask for exactly the data shape, nothing else. If you need
  objects, use `schema` rather than asking in prose.

## Length and cost

A brief is cheap: a few hundred tokens once, against an agent that will spend
tens of thousands. Under-briefing is almost always the more expensive error.

The exception is `inherit_context`, which forks the whole parent conversation
into the child. That is not a brief, it is a bulk transfer — use it only when the
task genuinely depends on a long negotiated history, and prefer writing the three
relevant facts instead.
