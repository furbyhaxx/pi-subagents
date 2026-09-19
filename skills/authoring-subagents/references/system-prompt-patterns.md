# Writing a subagent system prompt

The body of an agent file is read on every turn of every run of that agent,
forever. It is the highest-leverage text in the extension and the easiest place
to waste tokens.

## Contents

- [What the harness already said](#what-the-harness-already-said)
- [The shape](#the-shape)
- [Principles](#principles)
- [Writing the description](#writing-the-description)
- [Output contracts](#output-contracts)
- [Worked examples](#worked-examples)
- [Anti-patterns](#anti-patterns)
- [Prompting a one-off agent instead](#prompting-a-one-off-agent-instead)

## What the harness already said

Do not repeat any of this. It is injected automatically.

| Injected | When |
|---|---|
| `<active_agent name="...">` | Always |
| `# Environment` — working directory, git repo/branch, platform | Always |
| The parent's **entire** system prompt (AGENTS.md, project rules, conventions) | `prompt_mode: append` |
| `<sub_agent_context>` — use `read`/`edit`/`write`/`find`/`grep` tools not shell equivalents, parallelize independent calls, absolute paths, no emojis, be concise | `prompt_mode: append` |
| `<worktree_scope>` — work in the copy, map paths into it, preserve pre-existing changes, do not switch branches or create worktrees, report worktree-relative paths | Worktree runs |
| `<workflow_child>` — your final message *is* the return value, return only the answer | Workflow children |
| Memory block (MEMORY.md head + usage instructions) | `memory:` set |
| Full text of each preloaded skill | `skills: a, b` |

Two consequences authors miss:

- In `append` mode you are writing an *addendum*. Restating "be concise" or
  "use absolute paths" adds nothing.
- In `replace` mode none of the project's conventions are present. If the agent
  writes code, either switch to `append` or restate the three rules that actually
  matter — not the whole AGENTS.md.

## The shape

```markdown
# Role
What this agent is for, in one or two sentences, in the caller's terms.

# Method
The steps that are non-obvious, or that the model reliably skips. With reasons.

# Boundaries
What it must not do, and what to do instead when it hits the wall.

# Output
The exact shape the caller needs.
```

Four sections, in that order, because that is the order the model needs them:
who am I, how do I proceed, where do I stop, what do I hand back. Omit a section
that has nothing real in it. Fifty lines is a lot; two hundred is almost always
a sign the agent is doing two jobs.

## Principles

**Explain why.** A rule with a reason generalizes; a bare imperative does not.

> Read the whole file before editing it — a grep snippet hides the second call
> site, and a partial edit compiles but breaks at run time.

is strictly better than `ALWAYS read the entire file.` The first survives a
situation you did not anticipate. Reach for capitalized `MUST`/`NEVER` only for
genuine safety boundaries (a read-only agent's write prohibition), where you
want literal compliance and do not care about generalization.

**Name the failure you are preventing.** Every rule in a good agent prompt exists
because something went wrong. Say what.

**Prefer deleting.** When an agent misbehaves, the reflex is to add a rule. Check
first whether an existing instruction *caused* the behavior — over-specified
prompts make models perform the process instead of doing the job. If two rules
can be replaced by one reason, do that.

**Do not encode the task.** The prompt is for the agent's *role*; the caller
supplies the task. A body that mentions `src/auth/` is a body that stops working
next quarter.

**Assume a cold reader.** The agent has not seen the conversation, does not know
the project, and cannot ask. Anything the role always needs belongs here;
anything this *run* needs belongs in the brief the caller writes.

**Tool discipline where it matters.** `bash` re-grants whatever `tools:` removed.
A read-only agent that keeps `bash` needs an explicit prohibition — this is what
the built-in `Explore` prompt spends its first section on, listing not just
"don't write files" but the specific escapes (`>`, `>>`, heredocs, `/tmp`,
state-changing commands).

## Writing the description

The `description` is not documentation — it is the routing signal the
orchestrator reads on every turn. Write it as a rule, not a title.

| Poor | Good |
|---|---|
| `Security agent` | `Reviews a diff or named files for injection, authz and secrets-handling defects. Use after an implementation agent finishes; do not use to write or fix code.` |
| `Helps with tests` | `Writes and repairs unit tests for one named module. Use when the implementation is settled and only coverage is missing; do not use to design the implementation.` |

Include the negative case. Most misrouting is an agent being picked for an
adjacent job, and the sentence that prevents it is "do not use for X".

If the agent takes a parameter the caller must supply (a breadth level, a target
path), say so in the description — that is where the caller looks. The built-in
`Explore` does this: *"specify search breadth: quick / medium / very thorough."*

## Output contracts

The output section is what makes an agent composable. Decide who reads it:

- **A human** — a short report: findings with absolute paths and line numbers,
  severity, and what to do. Say "no preamble" if you keep getting one.
- **The orchestrator, to act on** — a fixed, greppable shape. Spell out the
  template literally.
- **A workflow script** — the final message *is* the return value. Workflow
  children already get told this, but if the script needs objects, use `schema`
  on the `agent()` call rather than prose instructions.
- **Another agent, via the blackboard** — name the topic and key convention in
  the prompt so parallel agents do not each invent one.

Always ask for the negative result explicitly (`report "none"`), or you will get
a page of hedging when there is nothing to report.

## Worked examples

**A refutation judge** (`replace` mode, hermetic, strong model):

```markdown
# Role
You are given exactly one claim about this codebase. Your job is to try to
refute it, not to confirm it.

# Method
Start from the assumption that the claim is wrong. Look for the code path that
makes it false: the guard that already exists, the caller that never passes that
value, the test that covers it. Read the surrounding file, not just the cited
lines — a claim is most often wrong because of context the reporter did not read.

Only if you cannot find such a path should you conclude the claim holds.

# Boundaries
Do not fix anything. Do not broaden the claim into related issues; another agent
owns those. If the claim is too vague to test, say so instead of guessing what
it meant.

# Output
Verdict: refuted | holds | untestable
Evidence: file:line references that decided it.
One paragraph, no preamble.
```

Why it works: the adversarial framing is a *method*, not a tone instruction; the
"read the surrounding file" rule carries its reason; the untestable verdict gives
the model somewhere to go that is not a fabricated answer.

**A mechanical codemod worker** (`append` mode, cheap model):

```markdown
# Role
You apply one fully-specified transform to the files you are given. The decision
has already been made; you are executing it.

# Method
Work file by file. After each file, re-read the region you changed — a
search-and-replace that matched twice is the most common way this job goes wrong.

# Boundaries
If a file does not match the pattern you were told to expect, skip it and report
it. Do not improvise a variant of the transform, and do not fix unrelated
problems you notice — report them instead.

# Output
One line per file: path, changed | skipped, and the reason if skipped.
Then any unrelated problems you noticed, if any.
```

Why it works: it makes "stop and report" the cheap path, which is what keeps a
cheap model from confidently doing the wrong thing across twenty files.

## Anti-patterns

| Pattern | Why it hurts |
|---|---|
| Restating the injected bridge ("use read not cat") | Pure token cost in `append` mode |
| A wall of `ALWAYS`/`NEVER` | Literal compliance, no generalization, and the model spends turns proving compliance |
| Encoding this quarter's paths or ticket numbers | Rots; belongs in the caller's brief |
| A persona with no operational consequence ("you are a 10x engineer") | Costs tokens, changes nothing |
| Long worked examples of the *task* | Over-fits; the agent mimics the example instead of solving the case |
| "Ask the user if unsure" | A subagent has no user. Say what to do instead: report and stop |
| Telling the agent to spawn helpers | It has no `Agent` tool unless `allowed_subagents` is set |
| Instructing it to commit/push by default | Decide commit policy per delegation, not per role |
| Duplicating another agent's role "just in case" | Two agents that both review makes routing ambiguous |

## Prompting a one-off agent instead

If the behavior you want is specific to one task, do not write a file — put it in
the `Agent({ prompt })`. The brief is where the run's context belongs, and it
costs nothing when the agent is not being used. Writing that brief is covered in
[`../../coordinating-subagents/references/delegation-briefs.md`](../../coordinating-subagents/references/delegation-briefs.md).
