# pi-subagents: how it works

A condensed map of the extension for people configuring it. The extension's
`README.md` is the source of truth for defaults and setting names; `docs/` holds
the long-form guides (`workflows.md`, `messaging.md`, `rpc.md`,
`conversation-viewer.md`).

## Contents

- [Tools the model gets](#tools-the-model-gets)
- [Where things live on disk](#where-things-live-on-disk)
- [Settings](#settings)
- [Concurrency and join modes](#concurrency-and-join-modes)
- [Turn limits and statuses](#turn-limits-and-statuses)
- [Model scope](#model-scope)
- [UI surfaces](#ui-surfaces)
- [Handles and mentions](#handles-and-mentions)
- [Scheduling](#scheduling)
- [Messaging and blackboard](#messaging-and-blackboard)
- [Events and RPC](#events-and-rpc)
- [Limits](#limits)

## Tools the model gets

| Tool | Purpose |
|---|---|
| `Agent` | Spawn a subagent. Background by default. |
| `get_subagent_result` | Status and full result for a background agent (`wait`, `verbose`). |
| `steer_subagent` | Inject a message into a running agent. |
| `SubagentWorkflow` | Run a deterministic JS script orchestrating many agents. |
| `AgentMessage` | Peer-to-peer messages: `send`, `broadcast`, `inbox`, `wait`, `peers`. |
| `Blackboard` | Durable keyed board: `put`, `get`, `list`, `delete`, `watch`. |

`Agent` parameters: `prompt`, `description`, `subagent_type` (required);
`name`, `model`, `thinking`, `max_turns`, `run_in_background`, `resume`,
`isolated`, `isolation`, `branch`, `inherit_context`, `schedule`.

Nested agents get ownership-scoped copies of `Agent`,
`get_subagent_result` and `steer_subagent` only when `allowed_subagents` is set.
A subagent session never activates the extension itself, so it has no `/agents`
command, no RPC handlers and no `subagents:ready` event.

## Where things live on disk

```text
<session artifact root>/<project>/<root-session-id>/
├── tasks/        # <agent-id>.output transcripts, <run>.workflow.js, <run>.workflow.jsonl
└── worktrees/    # default worktree container
```

Default artifact root: `<agent dir>/sessions` (`~/.pi/agent/sessions`), or
`<PI_CODING_AGENT_SESSION_DIR>/subagents` when that override is set. An explicit
`sessionArtifactDirectory` always wins. `worktreeDirectory` chooses the worktree
container independently: `{mode:"session"}` (default),
`{mode:"project"}` (`<repo>/.worktrees/`, which must already be git-ignored), or
`{mode:"custom", path}`.

Other locations:

| Thing | Path |
|---|---|
| Agent files | `.pi/agents/`, `.agents/agents/`, `<agent dir>/agents/` |
| Saved workflows | `.pi/workflows/`, `.agents/workflows/`, `<agent dir>/workflows/` |
| Agent memory | `.pi/agent-memory/`, `.pi/agent-memory-local/`, `<agent dir>/agent-memory/` |
| Settings | `~/.pi/agent/subagents.json` (global), `<cwd>/.pi/subagents.json` (project) |
| Schedules | `<cwd>/.pi/subagent-schedules/<sessionId>.json` |
| Messaging store | `<agent dir>/messaging/<project-hash>/messaging.sqlite3` |

Artifact changes apply to new sessions only; nothing is migrated, expired or
cleaned up automatically.

## Settings

Project `<cwd>/.pi/subagents.json` overrides global `~/.pi/agent/subagents.json`
per field. `/agents → Settings` writes the project file.

| Key | Default | Effect |
|---|---|---|
| `maxConcurrent` | `10` | Background agents running at once; the rest queue |
| `maxConcurrentForeground` | `0` (unlimited) | Bounds blocking spawns in one message |
| `defaultMaxTurns` | unlimited | Default turn ceiling |
| `maxRetries` | `3` | pi retries per model candidate |
| `maxModelWraparounds` | `0` | Extra full passes over the fallback list |
| `graceTurns` | `5` | Turns allowed after the wrap-up steer |
| `maxSubagentDepth` | `2` | Nesting ceiling; `0`/`1` disables nesting |
| `fallbackSubagent` | `general-purpose` | Where unresolvable types go; `none` = fail closed |
| `defaultJoinMode` | `smart` | `smart` \| `async` \| `group` |
| `backgroundByDefault` | `true` | What an unqualified `Agent` call means |
| `rememberAgents` | `true` | Persist child sessions (enables late `@handle` resume) |
| `outputTranscript` | `true` | Write `.output` transcripts |
| `schedulingEnabled` | `true` | `schedule` parameter exists at all |
| `scopeModels` | `false` | Validate models against pi's `enabledModels` |
| `disableDefaultAgents` | `false` | Hide the three built-ins |
| `strictAgentFiles` | `false` | Broken agent file aborts startup instead of warning |
| `agentMentions` | `"model"` | `model` \| `direct` \| `off` |
| `worktreeIsolation` | `true` | `isolation`/`branch` exist at all |
| `worktreeDirectory` | `{mode:"session"}` | Worktree container |
| `sessionArtifactDirectory` | — | Artifact root override |
| `workflowsEnabled` | auto (on) | `SubagentWorkflow` registration; auto stands down for a rival workflow tool |
| `toolDescriptionMode` | `"full"` | `full` (~1,400 tok) \| `compact` (~75% smaller) \| `custom` |
| `widgetMode` | `"background"` | `all` \| `background` \| `off` |
| `fleetView` | `true` | The list below the editor |
| `reportUsage` | `false` | Fold subagent spend into this session's stats |
| `showCost` / `showModel` | `false` | Extra columns on the subagent surfaces |
| `viewerMode` / `viewerMarkdown` | `"steps"` / `"assistant"` | Conversation viewer defaults |
| `messaging` | object, enabled | See [messaging](#messaging-and-blackboard) |

Schema-level settings (`toolDescriptionMode`, `disableDefaultAgents`,
`schedulingEnabled`, `worktreeIsolation`, `workflowsEnabled`) apply on the next
pi session, because the tool schema is built at registration. Runtime enforcement
is immediate.

`toolDescriptionMode: "custom"` reads
`<cwd>/.pi/agent-tool-description.md` or `<agentDir>/agent-tool-description.md`,
supporting `{{typeList}}`, `{{compactTypeList}}`, `{{agentDir}}`,
`{{isolationGuideline}}` and `{{scheduleGuideline}}`. Start from
`examples/agent-tool-description.md`, which reproduces the default exactly.

## Concurrency and join modes

Two independent pools: background (`maxConcurrent`, default 10) and foreground
(`maxConcurrentForeground`, default unlimited). They are deliberately separate —
a foreground agent blocks its parent anyway. Nested children and a workflow's
agents are outside both; a workflow caps itself at `max(1, min(16, cpus - 2))`.

Join mode controls how background completions are delivered:

| Mode | Behavior |
|---|---|
| `smart` (default) | 2+ agents spawned in the same turn are consolidated into one notification; solo agents notify individually |
| `async` | Every agent notifies on its own — best when results need incremental processing |
| `group` | Force grouping even for a single agent |

Grouped notifications use a 30s timeout after the first completion, then a
partial notification and a 15s re-batch window for stragglers.

## Turn limits and statuses

At `max_turns` the agent is steered "wrap up immediately", gets up to
`graceTurns` more, then is hard-aborted.

| Status | Meaning | Icon |
|---|---|---|
| `completed` | Finished naturally | `✓` green |
| `steered` | Hit the limit, wrapped up in time | `✓` yellow |
| `aborted` | Grace period exceeded | `✗` red |
| `stopped` | User-initiated abort | `■` dim |

`steered`, `aborted` and `stopped` results are explicitly labelled partial.

## Model scope

Opt-in (`scopeModels`). Validates each spawn's effective model against pi's
`enabledModels` (project settings override global).

| Source | Out-of-scope behavior |
|---|---|
| `Agent({ model })` | Hard error listing allowed models |
| Cross-extension RPC spawn | Hard error to the calling extension |
| Agent frontmatter | Warning, runs anyway (frontmatter is authoritative) |
| Parent-inherited | Warning, runs anyway |

Only exact `provider/modelId` entries are honored; globs and bare IDs are
dropped. An empty or missing `enabledModels` makes the check a no-op.

## UI surfaces

- **Widget** above the editor: running agents, spinners, live activity, turns,
  tool uses, tokens with context percentage and compaction count, elapsed time.
- **FleetView** below the editor: `main` plus every running agent, earliest
  first; workflows appear as one row. `↓`/`←` at an empty prompt enters the list,
  `Enter` opens a live conversation, `Esc` returns.
- **Conversation viewer**: pinned task, Steps timeline (`Tab` for Raw, `o` for
  retained output, `t` for the task, `m` cycles markdown, `Enter` steers, `x`
  twice stops).
- **`/agents`**: running agents, agent types, scheduled jobs, workflow runs,
  blackboard, peers, jobs, create, settings.
- **`/agents → Workflows`**: two-pane run inspector. `x` stop, `p` pause,
  `s` skip an agent (its `agent()` returns `null`), `r` retry, `c` open the
  child's conversation.

## Handles and mentions

Every top-level agent has a handle: its type lowercased, numbered on collision
(`explore`, `explore-2`), plus any `name` the orchestrator gave it. `@handle msg`
at the prompt messages a running agent, resumes a finished one, reopens an
evicted one from disk, or starts one that never ran — without a turn in the main
conversation.

`agentMentions: "model"` (default) starts a new agent through an off-screen clone
of the conversation that makes a real `Agent` call, so the agent gets a
context-written prompt; `"direct"` starts it immediately with your text verbatim
and no model call; `"off"` disables the whole surface. Only a leading mention is
routed; `@main` forces text back to the main model. Nested children are not
addressable.

## Scheduling

`Agent({ schedule })` registers a later fire: 6-field cron (`"0 0 9 * * 1"`),
interval (`"5m"`), one-shot relative (`"+10m"`), or ISO timestamp. Schedules are
session-scoped, reset on `/new`, restore on `/resume`, and bypass the
`maxConcurrent` queue. They cannot combine with `inherit_context` or `resume`,
and always run in the background. Headless `pi -p` does not wait for them.

## Messaging and blackboard

SQLite is the only source of truth; a Unix socket carries advisory wakeups only,
so losing it costs latency, never a message. Scope defaults to `project`, so
agents in two terminals are peers.

- `AgentMessage`: `send`, `broadcast` (live subagents only, never wakes anyone),
  `inbox`, `wait`, `peers`. Authorship is stamped, never submitted.
- `Blackboard`: `put`/`get`/`list`/`delete`/`watch`, with `if_revision`
  optimistic concurrency that returns the current value on conflict rather than
  erroring. The `operator/` prefix is agent-readable and agent-unwritable.
- What an incoming message costs the recipient is the **recipient's** setting
  (`messaging.surface`, or `messaging_surface` per agent): `off`, `ui` (default,
  a one-line notice), `context` (full body).
- Caps: 16 KiB message, 64 KiB board value, 500 keys per topic, 200 queued
  messages per agent, 1h TTL.

Full guide: `docs/messaging.md`.

## Events and RPC

Lifecycle events on `pi.events`, top-level agents only:
`subagents:created`, `:started`, `:completed`, `:failed`, `:steered`,
`:compacted`, `:scheduled`, `:scheduler_ready`, `:ready`,
`:settings_loaded`, `:settings_changed`.

`:completed`/`:failed` carry `status`, `durationMs`, `toolUses`, `result`,
`tokens` (display total, excludes `cacheRead`) and `usage` (billing view,
includes `cacheRead` and `cost.total`).

RPC channels for other extensions: `subagents:rpc:ping`, `:spawn`, `:stop`,
`:consume`, with `{success, data|error}` envelopes and per-`requestId` reply
channels. Workflows are not drivable over RPC and their children emit no events.
Full reference: `docs/rpc.md`.

## Limits

| Limit | Value |
|---|---|
| Background concurrency | `maxConcurrent`, default 10 |
| Workflow concurrency | `max(1, min(16, cpus - 2))` |
| Agents per workflow run | 1000 |
| Items per `parallel`/`pipeline` call | 4096 |
| Nested `workflow()` calls per run | 256 |
| Workflow script length | 512 KiB |
| Nesting depth | `maxSubagentDepth`, default 2 |
| Message body / board value | 16 KiB / 64 KiB |

Above 25 scheduled agents or 1.5M tokens, a workflow card warns that the run is
large.
