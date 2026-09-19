---
name: authoring-subagents
description: Design, write, tune and evaluate pi-subagents agent types — .pi/agents/*.md frontmatter, system prompt bodies, tool and extension scoping, model and thinking-level selection across Anthropic/OpenAI/Google/DeepSeek/Z.ai/xAI/Moonshot/MiniMax, memory, preloaded skills, and the subagents.json settings that shape them. Use this whenever someone creates, edits, ejects, debugs or optimizes a subagent or agent type, asks which model or thinking level an agent should run on, writes or rewrites an agent system prompt, or wonders why an agent has the wrong tools, model, context or behavior — including casual asks like "make me an agent that reviews migrations" or "why is Explore so slow".
---

# Authoring subagents

An agent type is a `.md` file: YAML frontmatter that decides what the agent *is*
(tools, model, context, lifetime) and a body that decides how it *behaves*. This
skill is about writing that file well, picking the model, and proving the agent
actually does the job before it gets used a hundred times.

Delegating to agents is [`coordinating-subagents`](../coordinating-subagents/SKILL.md).
Splitting work into agent-sized units is [`executing-work-with-subagents`](../executing-work-with-subagents/SKILL.md).

## First: does this need a new agent type?

Most "I need an agent for X" is really "I need a good prompt for X". A new type
earns its place when the *configuration* is what makes it work — not the wording.

| Situation | Do this |
|---|---|
| One-off task, ordinary tools | `Agent({ subagent_type: "general-purpose", prompt })` — no file |
| Find where something lives | Built-in `Explore` — already read-only and on a cheap model |
| Design before implementing | Built-in `Plan` |
| Same job repeatedly, with a tool/model/prompt shape you keep re-typing | Write a type |
| The job must be denied write access, or needs a specific model, memory, or a preloaded skill | Write a type |
| A built-in is almost right | Eject it (`/agents` → agent → Eject) and edit the copy, or override by name |

A type you invoke twice a year is worse than a paragraph in a prompt: it costs
context in the `Agent` tool description on every single turn, for every session.

## The five decisions

Every agent file answers these. Decide them explicitly; defaults are chosen for
a general assistant, not for your specialist.

1. **Identity** — `name` (the `subagent_type` and `@handle`), `description`, and
   the body. The `description` is the routing signal: it is what the orchestrator
   reads when deciding whether to send work here, so write it as *when to use
   this and when not to*, not as a job title.
2. **Capability** — `tools:`, `extensions:`, `disallowed_tools:`, `isolated:`.
   This is a privilege decision, not a convenience one.
3. **Brains** — `models:` (ordered fallback list), `thinking:`, `max_turns:`.
4. **Context** — `prompt_mode:` (`replace` vs `append`), `skills:`, `memory:`,
   `inherit_context:`.
5. **Lifecycle** — `run_in_background:`, `isolation:`, `persist_session:`,
   `allowed_subagents:`.

Full field table, precedence rules and scoping semantics:
[`references/agent-file-reference.md`](references/agent-file-reference.md).

## Where the file goes

| Priority | Path | Scope |
|---|---|---|
| 1 | `.pi/agents/<name>.md` | Project — authoritative, where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — shared cross-tool workspace |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`) | Global |

Project beats global; `.pi/` beats `.agents/`. The type is the frontmatter
`name:`, falling back to the filename — so `blubb.md` with `name: code-review`
dispatches as `code-review`. Claiming a default agent's name overrides it.

## Writing the body

The body is a system prompt, but it is not a whole system prompt. Read what the
harness already injects before you write a word of it — repeating any of this is
pure token cost and reads as noise to the model:

- an `<active_agent name="...">` tag and an `# Environment` block (cwd, git
  branch, platform);
- in `prompt_mode: append`, the **entire parent system prompt** plus a
  `<sub_agent_context>` bridge that already says: use `read` not `cat`, `edit`
  not `sed`, `write` not heredocs, `find`/`grep` tools not shell equivalents,
  parallelize independent tool calls, absolute paths, no emojis, be concise;
- a `<worktree_scope>` block when the agent runs in a worktree, which already
  tells it to stay in the copy, preserve pre-existing changes, and not switch
  branches;
- memory and preloaded-skill blocks when `memory:` / `skills:` are set.

So the body should carry only what is specific to *this* agent: its job, its
method, its boundaries, and the shape of its answer.

**`replace` (default) vs `append`.** `replace` gives the agent a standalone
identity and deliberately drops AGENTS.md / CLAUDE.md inheritance — right for a
specialist whose job is narrow and whose project conventions are irrelevant or
actively distracting (a search agent, a refutation judge). `append` makes the
agent a parent twin that inherits every project rule — right when the agent
writes code that must satisfy the same conventions the main session does. An
`append` agent with an empty body is a pure clone of the parent, which is exactly
what `general-purpose` is.

Structure that works, and why:

```markdown
# Role
One or two sentences. What this agent is for, in the terms the caller thinks in.

# Method
The steps that are non-obvious or that the model reliably skips. Say *why*.
"Read the whole file before editing it — snippets hide a second call site"
beats "ALWAYS read files fully."

# Boundaries
What it must not do, and what to do instead when it hits the wall.

# Output
The exact shape the caller needs. A downstream reader — a human, or a script
interpolating this into the next prompt — cannot parse a shape you didn't ask for.
```

Explain the reasoning behind a rule rather than shouting it. A model that
understands why a constraint exists generalizes it to the case you did not
anticipate; a model given `ALWAYS`/`NEVER` with no reason follows it literally
and off a cliff. Patterns, worked examples and anti-patterns:
[`references/system-prompt-patterns.md`](references/system-prompt-patterns.md).

## Capability is a privilege boundary

`extensions:` decides which extensions *load*; `tools:` decides which tools
*surface*. Three rules that catch people out:

- A read-only agent is defined by the absence of `write`/`edit`, and that
  absence also silently switches `memory:` to read-only — which is usually what
  you want, but know that it happened.
- `bash` re-grants everything you removed. An agent with `tools: read, grep, bash`
  is not read-only; it can `python -c`. The built-in `Explore` and `Plan` prompts
  spend a whole section forbidding writes through bash for exactly this reason.
  Copy that section or drop `bash`.
- `allowed_subagents:` grants this agent the union of what the listed agents can
  do, because a child runs with *its own* tools, not the parent's. `all` on a
  read-only agent makes it a writer. Choose the list as carefully as `tools:`.

## Model and thinking level

Pin a model when the agent's job has a shape that a specific tier serves better
than whatever the main session happens to run on — a cheap, fast model for
search and mechanical edits; a strong reasoner for architecture, review and
adversarial verification. Otherwise inherit, and let the caller's choice apply.

Prefer `models:` (an ordered fallback list) over `model:`. Frontmatter candidates
must be canonical `provider/modelId[:thinking]` and are matched exactly;
unavailable ones are skipped, and pi advances through the list without replaying
the prompt after its own retries are exhausted.

Current per-vendor model data, the tiering, and a job-to-model table:
[`references/model-selection.md`](references/model-selection.md). Model IDs and
prices go stale fast — that file says how to re-verify before you quote one.

Thinking level is orthogonal and cheaper to get wrong in the expensive
direction: `off`/`low` for search, listing and mechanical transforms; `medium`
for implementation; `high`/`xhigh` for review, planning and verification. A
candidate suffix (`:high`) overrides the `thinking:` field for that candidate,
and pi clamps a level the model does not support rather than failing.

## Prove it works

An agent definition is a program that runs a hundred times. Do not ship it on
one lucky run.

1. Give it two or three *realistic* tasks — the kind the agent will actually get,
   including one near the edge of its scope and one it should refuse or escalate.
2. Run each one, and read the **transcript**, not just the final answer. The
   transcript is at `<agent dir>/sessions/<project>/<session>/tasks/<id>.output`,
   or open the conversation viewer from `/agents → Running agents`.
3. Look for wasted motion: tools it reached for and could not use, files it
   re-read, instructions it restated instead of following, turns spent deciding
   what you could have told it.
4. Compare against the baseline the agent is supposed to beat — usually
   `general-purpose` with the same prompt. If it does not beat that, the file is
   costing context for nothing.
5. Change one thing at a time, and prefer *deleting* to adding. Most bad agent
   files are over-specified, not under-specified.

Method, metrics to actually measure, and how to read a transcript:
[`references/evaluating-agents.md`](references/evaluating-agents.md).

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Agent ignores project conventions | `prompt_mode: replace` (the default) drops AGENTS.md | Use `append`, or restate the few rules that matter |
| Agent edits files it was told not to | `bash` present, or a listed `allowed_subagents` child can write | Drop `bash` / tighten the allowlist; prompt alone is not enforcement |
| `(unavailable, fallback: inherit)` in `/agents` | Frontmatter model ID does not resolve | Re-check the exact ID; frontmatter is matched exactly, not fuzzily |
| Agent never gets picked for its job | `description` reads as a title, not a routing rule | Rewrite as "use for X; do not use for Y" |
| Agent burns context restating the task | Body duplicates the injected bridge/env blocks | Delete those sections |
| Type silently resolves to general-purpose | Unknown/disabled/case-ambiguous type name | Check `/agents`; set `fallbackSubagent: none` to fail loudly instead |
| Edits to the file do nothing | Same `name:` claimed by a higher-priority file | Check all three discovery roots |

## References

| File | Read it when |
|---|---|
| [`references/agent-file-reference.md`](references/agent-file-reference.md) | Writing or debugging frontmatter; tool/extension scoping; memory; skills; nesting |
| [`references/model-selection.md`](references/model-selection.md) | Choosing or justifying a model, thinking level or fallback list |
| [`references/system-prompt-patterns.md`](references/system-prompt-patterns.md) | Writing the body; worked examples; anti-patterns |
| [`references/evaluating-agents.md`](references/evaluating-agents.md) | Testing an agent, comparing variants, measuring cost |
| [`references/extension-reference.md`](references/extension-reference.md) | Settings, storage layout, events, RPC, `/agents` menu, what the feature can and cannot do |

Source of truth for every default and setting name is the extension's own
`README.md`; these references summarize it for authoring decisions.
