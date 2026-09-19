# Agent file reference

Everything that goes in a `.pi/agents/<name>.md` file, what it does, and the
rules that are not obvious from the field name. The extension's `README.md` is
the source of truth for defaults; this is the authoring view of it.

## Contents

- [Discovery and precedence](#discovery-and-precedence)
- [Frontmatter fields](#frontmatter-fields)
- [Tool and extension scoping](#tool-and-extension-scoping)
- [Models and thinking](#models-and-thinking)
- [Context: prompt_mode, skills, memory, inherit_context](#context-prompt_mode-skills-memory-inherit_context)
- [Nested subagents](#nested-subagents)
- [Isolation and worktrees](#isolation-and-worktrees)
- [Persistence and transcripts](#persistence-and-transcripts)
- [Messaging surface](#messaging-surface)
- [Worked examples](#worked-examples)
- [Failure behavior](#failure-behavior)

## Discovery and precedence

| Priority | Location | Scope |
|---|---|---|
| 1 | `.pi/agents/<name>.md` | Project — pi's config dir, where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — shared cross-tool `.agents` workspace |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`) | Global |

- The agent's type is frontmatter `name:`, falling back to the filename. Two
  files may declare the same name; the later load wins and a warning names the
  file that took over.
- A `name` containing `:` is rejected (reserved for plugin-scoped identifiers).
- Project overrides global. `.pi/agents/` overrides `.agents/agents/`.
- Type matching is case-insensitive. A type that resolves to zero or to two
  enabled agents falls back to `fallbackSubagent` (default `general-purpose`)
  with a note — or is refused outright when that setting is `none`.
- Defaults (`general-purpose`, `Explore`, `Plan`) can be **ejected** to a file
  (`/agents` → agent → Eject), **overridden** by claiming the name, or
  **disabled** with `enabled: false`.

## Frontmatter fields

All optional.

| Field | Default | Notes for authors |
|---|---|---|
| `name` | filename | The dispatch identity and `@handle`. |
| `description` | filename | What the orchestrator reads when routing. Write "use for X, not for Y". |
| `display_name` | the type | UI label only. |
| `color` | — | Badge color: Claude Code names (`red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`), quoted hex (`"#8B5CF6"`), or Agency aliases (`amber`, `teal`, `indigo`, `gold`, `neon-green`, `neon-cyan`, `metallic-blue`, `violet`, `rose`, `lime`, `gray`, `fuchsia`, `slate`, `navy`). Invalid values render no badge. |
| `tools` | all 7 built-ins | `read, grep, find, ls, bash, write, edit`, plus `*`/`all`, `none`, and `ext:<extension>[/<tool>]`. |
| `extensions` | `true` | `true`, `false`, or a list (`[mcp, "/abs/path.ts", "*"]`). |
| `exclude_extensions` | — | Denylist applied after `extensions:`; exclude always wins. Plain names only. |
| `skills` | `true` | `true` inherits the parent's skills, `false` none, a comma-separated list preloads **only** those into the system prompt. |
| `memory` | — | `project` \| `local` \| `user`. Read-only automatically for agents without `write`/`edit`. |
| `disallowed_tools` | — | Denied even if an extension provides them. Also respected when deciding memory write capability. |
| `isolation` | — | `worktree` for a disposable copy, or `off` to veto worktrees (authoritative — a caller's `branch` against it errors). |
| `model` | inherit | Scalar alias for `models: [model]`. Canonical `provider/modelId[:thinking]` only. Cannot combine with `models`. |
| `models` | inherit | Ordered, non-empty fallback list. Each entry may carry a `:level` suffix. |
| `thinking` | inherit | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A candidate's suffix wins for that candidate; pi clamps unsupported levels down. |
| `max_turns` | unlimited | Graceful: a wrap-up steer at the limit, then up to `graceTurns` (default 5) to finish, then hard abort. |
| `persist_session` | `rememberAgents` (default `true`) | Whether the child's pi session is written to disk; what lets `@handle` reopen it much later. |
| `output_transcript` | `true` | Whether the `.output` transcript file is written. Independent of `persist_session`, worktrees and `memory:`. |
| `session_dir` | pi default | Where a persisted session lands. A session outside the parent's directory lists as a root instead of nesting. |
| `allowed_subagents` | none | Opt in to nested delegation. `all`/`"*"`/`true`, or a comma-separated type list. |
| `prompt_mode` | `replace` | `replace` = body is the whole prompt (no AGENTS.md inheritance); `append` = body appended to the parent's prompt. |
| `inherit_context` | `false` | Fork the parent conversation into the agent. |
| `run_in_background` | — | Pin background (`true`) or foreground (`false`); omit to follow `backgroundByDefault`. |
| `isolated` | `false` | Hermetic: forces `extensions: false` + `skills: false`, drops `ext:` selectors, and removes the messaging tools. Distinct from `isolation: worktree`. |
| `messaging_surface` | `messaging.surface` (default `ui`) | What an incoming peer message costs *this* agent's context: `off`, `ui`, `context`. |
| `enabled` | `true` | `false` hides the agent (including a default, per project). |

**Frontmatter is authoritative** for `thinking`, `max_turns`, `inherit_context`,
`run_in_background`, `isolated` and `isolation`. Models are the deliberate
exception: an explicit `Agent({ model })` replaces the configured list.

## Tool and extension scoping

`extensions:` is the only loading authority. `tools:` only decides what surfaces.

```yaml
tools: read, grep, find           # narrow built-ins; extensions still load
tools: "*"                        # all built-ins (alias: all)
tools: none                       # zero built-ins (extension tools may still surface)
tools: "*, ext:mcp/search"        # built-ins plus one extension tool
extensions: false                 # no extensions load
extensions: [mcp]                 # only mcp
exclude_extensions: pi-notify     # drop one, keep the rest
isolated: true                    # built-ins only, no extensions/skills/messaging
```

Rules worth knowing before you write a restricted agent:

- Any `ext:` entry flips extension tools to an **explicit allowlist**: unnamed
  extensions still load and their handlers fire, but they expose no tools.
- `ext:foo` cannot load `foo`; a mismatch fires an `extension-error:` warning.
- Extension names are case-insensitive; tool names in `ext:foo/bar` are not.
- Lazily-registering (MCP-backed) extensions are re-scoped as their tools appear.
- A plain `tools:` typo fails loudly (`tools-error:`) rather than producing a
  silently under-tooled agent.
- `exclude_extensions:` beats everything, but it is **not a sandbox** — the
  excluded extension's factory still runs once at load.
- An agent whose tools include `bash` also receives the background-jobs family
  (`job_list`, `job_output`, `job_stop`) when the parent's `bash` comes from the
  background-jobs extension — even under `isolated: true`. Trim individual ones
  with `disallowed_tools`.

**How scope is advertised.** The `Agent` tool description shows each agent with a
`(Tools: …)` suffix built from built-ins only, because extension tools resolve at
run time:

| `tools:` | suffix |
|---|---|
| omitted / `*` / `all` | `*` |
| a list | that list |
| `none` with `isolated: true` or `extensions: false` | `none` |
| `none` or only `ext:` entries, extensions loading | `no built-ins, extension tools only` |

## Models and thinking

- Frontmatter candidates are matched **exactly**. Fuzzy names, separator and
  date-stamp normalization and provider substitution apply only to explicit
  tool/RPC/workflow overrides — not to agent files.
- Unavailable configured candidates are skipped at spawn.
- pi runs its own retries on the active candidate first (`maxRetries`, default
  3); only after those does the same session advance to the next candidate,
  without replaying the prompt or completed tools. `maxModelWraparounds`
  (default 0) allows additional full passes.
- Tool/schema/worktree failures, cancellation and non-retryable provider errors
  do not advance the list.
- A literal model ID that ends in a thinking-level word wins over suffix parsing
  when that exact ID exists.
- With `scopeModels` on, a frontmatter model outside pi's `enabledModels`
  warns and runs anyway (frontmatter is trusted user config); a *caller-supplied*
  one is a hard error.

See [`model-selection.md`](model-selection.md) for what to pick.

## Context: prompt_mode, skills, memory, inherit_context

**`prompt_mode`.** `replace` builds: `<active_agent>` tag, a short "you are a
sub-agent" header, the `# Environment` block, then your body. `append` builds:
the parent's entire system prompt (verbatim, so it stays a cacheable prefix), a
`<sub_agent_context>` bridge of tool-usage rules, the `<active_agent>` tag, the
env block, then your body inside `<agent_instructions>`. Choose `append` when the
agent must obey project conventions; choose `replace` for a narrow specialist.

**`skills`.** A comma-separated list preloads those skills' full text into the
system prompt — it does not merely make them available. Cost is the whole skill
body on every turn, so preload only what the agent needs *every* run. Discovery
roots, in order: `<cwd>/.pi/skills/`, `<cwd>/.agents/skills/`,
`$PI_CODING_AGENT_DIR/skills/`, `~/.agents/skills/`, `~/.pi/skills/`. Per root a
name resolves as `<root>/foo.md`, then `<root>/foo/SKILL.md`, then a recursive
`*/…/foo/SKILL.md`.

**`memory`.** `project` → `.pi/agent-memory/<name>/` (committed), `local` →
`.pi/agent-memory-local/<name>/` (gitignored), `user` →
`<agentDir>/agent-memory/<name>/`. A `MEMORY.md` index plus individual files.
Agents without write tools get read-only memory automatically, which prevents
tool escalation through memory.

**`inherit_context`.** Forks the parent conversation into the agent — a text
rendering of it, not a session clone. Expensive and usually unnecessary: a good
brief is cheaper and more precise than the whole conversation. Reach for it when
the task genuinely depends on a long negotiated history.

## Nested subagents

Default-off. `allowed_subagents` injects ownership-scoped `Agent`,
`get_subagent_result` and `steer_subagent` tools into the agent.

- **The allowlist is a privilege boundary.** A child runs with its own `tools:`,
  `extensions:` and `isolated:` — nothing is inherited from the parent — so the
  parent effectively gains the union of what the listed agents can do.
- Unknown, disabled and out-of-list types are rejected rather than falling back,
  regardless of `fallbackSubagent`.
- Depth is capped by `maxSubagentDepth` (default 2: main 0 → subagent 1 → nested
  2). An agent at the cap gets no nested tools at all.
- A nested child must set its own `allowed_subagents` to delegate further;
  `isolated: true` agents never get nested tools.
- Nested children are invisible at top level: no handles, no lifecycle events, no
  `/agents` rows, not addressable as messaging peers. They are stopped when their
  parent settles. Their transcripts are written and their token spend rolls up
  into every ancestor's totals.
- They occupy no concurrency slot in either pool. The depth cap bounds depth, not
  width — pair `allowed_subagents` with `max_turns` to bound fan-out.

## Isolation and worktrees

- `isolation: worktree` in frontmatter gives every run a disposable detached copy;
  changes are preserved on a `pi-agent-*` branch before the copy is removed.
- `isolation: off` **vetoes** worktrees for this agent. An explicit caller
  `branch` against that veto is an error, not an unisolated run.
- A fresh worktree never contains the caller's uncommitted or staged changes — so
  never use one to review the working-tree diff.
- Worktree behavior, retained `branch` workspaces and their lease rules are a
  delegation-time decision; see
  [`../../executing-work-with-subagents/references/worktrees-and-branches.md`](../../executing-work-with-subagents/references/worktrees-and-branches.md).

## Persistence and transcripts

Three independent switches, often confused:

| Switch | Controls |
|---|---|
| `persist_session` / `rememberAgents` | The child's pi session file — what makes `@handle` resumable after its record is evicted |
| `output_transcript` / `outputTranscript` | The `.output` JSON-lines transcript under `<artifact root>/tasks/` |
| `memory:` | Durable memory files the agent reads and writes |

Turning one off does not turn the others off. To keep a run entirely off disk you
need all three, plus no worktree.

## Messaging surface

`messaging_surface` decides what an incoming peer message puts into *this*
agent's context: `off` (nothing until it calls `inbox`), `ui` (a one-line notice
with the unread count — the default), `context` (the full body). The setting
belongs to the reader; a sender never decides. Set `context` only for an agent
whose whole job is to react to peer traffic. `isolated: true` agents get no
messaging tools at all.

## Worked examples

**Read-only reviewer on a strong model.**

```yaml
---
name: code-review
description: Reviews a diff or a set of files for correctness and security defects. Use after an implementation agent finishes. Do not use to write or fix code.
color: red
tools: read, grep, find, ls
thinking: high
max_turns: 30
---
```

**Cheap mechanical worker, project conventions inherited.**

```yaml
---
name: codemod
description: Applies one mechanical, fully-specified transform across named files. Use when the change is decided and only needs executing; do not use for design work.
tools: read, edit, grep, find
prompt_mode: append
models:
  - anthropic/claude-haiku-4-5
thinking: low
max_turns: 20
---
```

**Hermetic specialist that must not touch the network or MCP tools.**

```yaml
---
name: refuter
description: Adversarially tries to refute a single claim it is given. Use to verify a finding before acting on it. Never use it to produce findings.
isolated: true
tools: read, grep, find
thinking: xhigh
max_turns: 12
---
```

**Fan-out owner with a bounded allowlist.**

```yaml
---
name: audit-lead
description: Coordinates a per-file audit by delegating to support agents. Use for repo-wide audits; do not use for single-file questions.
tools: read, grep, find
allowed_subagents: refuter, code-review
max_turns: 25
---
```

## Failure behavior

- An unreadable or unparseable agent file is **skipped with a warning** naming
  the file and, if it was an override, the file that loads instead. Set
  `strictAgentFiles: true` to fail startup instead (startup only — mid-session
  reloads still warn).
- `/agents → Agent types` flags a model that cannot be resolved
  (`(unavailable, fallback: inherit)`) or that resolves elsewhere
  (`(→ provider/id)`). Check there after editing `models:`.
- Malformed `subagents.json` is ignored with a stderr warning; individual
  out-of-range fields are dropped per field.
