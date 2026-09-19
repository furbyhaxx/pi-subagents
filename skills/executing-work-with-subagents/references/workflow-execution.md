# Executing work with SubagentWorkflow

A workflow is a deterministic JavaScript script that spawns and coordinates
subagents. Use it when the *number* of agents depends on something discovered at
run time, when work flows through stages, or when findings must be verified
before you believe them. The extension's `docs/workflows.md` is the full guide;
this is the execution view.

## Contents

- [When it beats plain Agent calls](#when-it-beats-plain-agent-calls)
- [Script anatomy](#script-anatomy)
- [pipeline vs parallel](#pipeline-vs-parallel)
- [agent() options](#agent-options)
- [Gates: verify by running](#gates-verify-by-running)
- [Schema: objects instead of prose](#schema-objects-instead-of-prose)
- [Resume and the journal](#resume-and-the-journal)
- [Branches inside a workflow](#branches-inside-a-workflow)
- [Patterns](#patterns)
- [Limits and sandbox rules](#limits-and-sandbox-rules)
- [Iterating and saving](#iterating-and-saving)
- [Troubleshooting](#troubleshooting)

## When it beats plain Agent calls

| Situation | Tool |
|---|---|
| One task, or a handful you can name now | `Agent` |
| "Audit every route file" — the list does not exist yet | Workflow |
| find → verify → fix, per item | Workflow (`pipeline`) |
| Success is `npm test` exiting zero | Workflow (`gate`) |
| You need sortable structured findings | Workflow (`schema`) |
| A loop until nothing new is found | Workflow |

It costs a subprocess per agent, so do not dress a single task up as one.

## Script anatomy

```js
export const meta = {
  name: 'auth-audit',
  description: 'Find routes missing auth checks, then verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }, { title: 'Verify' }],
}

phase('Scan')
const listing = await agent('List every route file under src/routes/. One path per line, nothing else.')
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
log(`auditing ${files.length} route files`)

phase('Audit')
const findings = await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks. Report findings or "none".`, { label: `audit:${file}` }),
  (found, file) => agent(`Try to REFUTE this finding about ${file}: ${found}`, { label: `verify:${file}`, phase: 'Verify' }),
)

return findings.filter(Boolean)
```

Rules:

- `meta` must be a **pure literal** — no variables, calls, spreads or template
  interpolation. It is evaluated before the script runs, which is what lets the
  phases render from the first frame.
- The body is an async function body: top-level `await` and a bare `return` are
  allowed (so the file is not valid standalone JS).
- What you `return` crosses a JSON boundary and is what the caller sees — not the
  individual agent outputs. Return something useful on its own.
- Use `phase` as an *option* inside `pipeline`/`parallel` stages; the ambient
  `phase()` races there.
- Take targets from `args` (`args?.root ?? 'src/'`) so the script is reusable.

## pipeline vs parallel

```js
await pipeline(items, stage1, stage2, ...)   // no barrier between stages
await parallel(thunks)                        // barrier: waits for all
```

**Default to `pipeline`.** Item A can be in stage 3 while item B is in stage 1,
so wall-clock is the slowest single chain rather than the sum of the slowest per
stage. Each stage receives `(previousResult, originalItem, index)`, so later
stages can label work without threading context through return values. A stage
that throws drops that item to `null` and skips its remaining stages.

**`parallel` is a barrier** and is earned only when the next step needs every
prior result *together*: dedup across the whole set, an early exit on zero
results, or a prompt that compares results against each other. Needing to
flatten, map or filter is not such a case — do it inside a stage.

A thunk or agent that fails becomes `null` rather than taking its siblings down,
so `.filter(Boolean)` before using results.

## agent() options

| Option | Notes |
|---|---|
| `label` | Display name in the progress tree; also the handle `resume` addresses |
| `phase` | Assign to a progress group explicitly (use this inside stages) |
| `agentType` | Which agent definition; defaults to `general-purpose`. **An unknown name falls back silently** — option keys are validated, values are not |
| `model` | `provider/modelId[:thinking]` or fuzzy. Replaces the definition's fallback list; omit normally |
| `effort` | `minimal`…`max`; omitted, the definition's `thinking` decides, then the parent's. Use `low` for mechanical stages, high tiers for verify/judge |
| `isolation: "worktree"` | Retained detached copy — expensive; use when parallel edits would collide |
| `branch` | Retained workspace on an exact local branch |
| `gate` | Shell command run after the agent finishes, in its effective cwd |
| `resume` | Continue the child that ran under that label |
| `schema` | JSON Schema with an object root; resolves to the validated object |

Combination rules: `resume` may be combined with `model`; it cannot be combined
with `agentType`, `effort`, `isolation`, `branch`, `gate` or `schema`.

`agent()` returns `null` when the child failed terminally **or** when you skipped
it from the inspector — indistinguishably. Be careful with retry-on-null loops:
they re-run what you deliberately skipped.

## Gates: verify by running

```js
const fixed = await agent('Fix the failing test in src/parser.ts.', { label: 'fix', gate: 'npm test' })
```

The gate runs in the child's effective working directory after it finishes and
**before** worktree settlement and lease release. For anonymous worktrees,
background jobs are quiesced before the gate; if quiescence cannot be
confirmed, the gate does not run. Named worktrees skip implicit job control.
A non-zero exit marks the agent failed and the command output becomes the
error.

Prefer `gate: 'npm test'` to asking another agent whether the code looks right. A
model judging whether a fix works is a weaker signal than the test suite.

Gate-and-retry, keeping the child's context:

```js
let fixed = await agent('Find and fix the failing test.', { label: 'fix', gate: 'npm test' })
if (fixed === null) {
  fixed = await agent('`npm test` is still failing. Fix the cause.', { label: 'fix', resume: 'fix' })
  const verified = await agent('Run `npm test` and report the result. Change nothing.',
    { label: 'verify', phase: 'Verify', gate: 'npm test', effort: 'low' })
  return { passed: verified !== null, summary: fixed }
}
```

A resumed child does **not** inherit or run its gate, which is why
re-verification needs its own gated call in the same workspace.

## Schema: objects instead of prose

```js
const VERDICT = {
  type: 'object',
  properties: { file: { type: 'string' }, holds: { type: 'boolean' }, why: { type: 'string' } },
  required: ['file', 'holds'],
}
await agent(prompt, { schema: VERDICT })
```

The child is given a `StructuredOutput` tool built from the schema and `agent()`
returns the validated object. A non-matching payload is rejected back to the
child, which corrects it; a child that never answers through the tool gets one
more prompt and then fails, so the call returns `null`.

`schema` is **pressure, not a guarantee** here (pi cannot force a tool call).
Keep schemas small and flat, and `.filter(Boolean)` after every schema stage.

## Resume and the journal

Every run journals each settled `agent()` call beside its script as
`<run id>.workflow.jsonl`. Re-running with `resumeFromRunId` replays the
**unchanged leading prefix** instantly and runs the first changed or failed call
— and everything after it — live.

It will not: cross sessions, resume a live run (stop it first), replay past a
named-`branch` call (branch files are mutable external state), replay a journaled
failure (that is the point — it retries exactly the call that died), or replay a
run whose journal contains `agent({ resume })` at all.

Before diagnosing why a completed workflow returned something empty or odd, read
that `.jsonl` — it records each agent's actual return value.

## Branches inside a workflow

```js
await agent('Implement src/x.ts; run npm test. Do not commit.', { label: 'fix', branch: 'feat/x', gate: 'npm test' })
await agent('Review src/x.ts and report remaining issues. Do not edit.', { branch: 'feat/x' })
```

Sequential calls on one branch share files, not conversation. The same lease
applies: never give two concurrent calls the same branch. Gates hold the lease
while verifying. Success, turn limit, abort, stop, failure, cancellation and
shutdown release it without committing, creating a preservation branch, merging,
resetting, stashing, cleaning, deleting or pruning anything. The completion reports the retained path
and change state. The orchestrating agent must review it, choose integration or
discard, create any needed branch/commit deliberately inside it, then remove and
prune it.

## Patterns

**Fan out over a runtime list** — one discovery agent, then `pipeline` over what
it returned.

**Adversarial verify** — N independent skeptics per finding, each prompted to
refute, killed on majority:

```js
const votes = await parallel(Array.from({length: 3}, () => () =>
  agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, { schema: VERDICT })))
const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
```

**Perspective-diverse verify** — give each verifier a different lens
(correctness, security, regression, reproduction) rather than N identical ones.

**Judge panel** — N independent attempts from different angles, scored by
parallel judges, synthesized from the winner.

**Loop-until-dry** — keep spawning finders until K consecutive rounds return
nothing new; deduplicate against everything *seen*, not against what survived
judging, or it never converges.

**Completeness critic** — a final agent asking "what is missing: a modality not
run, a claim unverified, a source unread?" Its answer is the next round.

**No silent caps** — when the script bounds coverage, `log()` what was dropped.

## Limits and sandbox rules

| Limit | Value |
|---|---|
| Concurrent agents | `max(1, min(16, cpus - 2))` — own pool, outside `maxConcurrent` |
| Agents per run | 1000 |
| Items per `parallel`/`pipeline` call | 4096 |
| Nested `workflow()` calls | 256, one level deep |
| Script length | 512 KiB |

The script has no filesystem, network or module access — all real work happens in
the agents. `Date.now()`, argless `new Date()`, `Math.random()`, `eval` and
`Function(...)` **throw**, because a script that varies run to run cannot be
replayed from its journal. Pass timestamps via `args`, stamp them after the run
returns, and vary prompts by index instead of randomly.

Above 25 scheduled agents or 1.5M tokens, the card warns that the run is large.

## Iterating and saving

The tool returns immediately with a run id and a `Script:` path. To iterate,
**edit that file** and re-run with `scriptPath` — do not re-emit the source.
Add `resumeFromRunId` to avoid re-paying for the unchanged prefix.

A script worth keeping goes in `.pi/workflows/<name>.js`,
`.agents/workflows/<name>.js`, or `<agent dir>/workflows/<name>.js` (first hit
wins), carrying its `export const meta` declaration; then invoke it by `name`.
Nothing lists saved workflows for you — `/agents → Workflows` is a run inspector
for the current session.

## Troubleshooting

| Message / symptom | Cause |
|---|---|
| `… is unavailable in workflow scripts (breaks resume)` | Called `Date.now()`, `new Date()` or `Math.random()` |
| `The meta object must be a PURE LITERAL` | `meta` references something; move it into the body |
| `agent() opts.<key> is not a recognised option` | Typo, or an option from another tool |
| An agent ran as the wrong type, silently | `agentType` value is not validated — check spelling in `/agents` |
| `agent()` returned `null` | Terminal failure, an inspector skip, or a schema never satisfied |
| Un-awaited `agent()` error | A dropped `await`, usually inside a stage |
| `Cannot run with isolation: "worktree"` | Not a git repo, no commits, or `git worktree add` failed — no workspace |
| Call fails naming a retained path | Verification failed after add; path retained conservatively |
| `No saved workflow named "x"` | Not in the three directories, or missing `export const meta` |
| Run seems stuck with agents queued | Concurrency cap; `p` (pause) also holds new starts |
