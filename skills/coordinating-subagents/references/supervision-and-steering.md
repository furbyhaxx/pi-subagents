# Supervising a running fleet

What to watch, when to intervene, and what each intervention costs.

## Contents

- [The surfaces](#the-surfaces)
- [Reading the status line](#reading-the-status-line)
- [Do not poll](#do-not-poll)
- [Steering](#steering)
- [Stopping](#stopping)
- [Resuming](#resuming)
- [Handles and addressing](#handles-and-addressing)
- [Notifications and join modes](#notifications-and-join-modes)
- [Queueing and concurrency](#queueing-and-concurrency)
- [Supervising a workflow](#supervising-a-workflow)
- [Transcripts](#transcripts)

## The surfaces

| Surface | Shows | Reach it |
|---|---|---|
| Widget (above the editor) | Every running background agent: spinner, live tool activity, turns, tool uses, tokens, context %, elapsed | Always on (`widgetMode`) |
| FleetView (below the editor) | `main` + running agents, workflows as one row | `↓` or `←` at an empty prompt |
| Conversation viewer | One agent's full live conversation | `Enter` on a FleetView row, or `/agents → Running agents` |
| `/agents` | Running agents, types, schedules, workflows, blackboard, peers, settings | `/agents` |
| Workflow inspector | Phases, per-agent state, stop/pause/skip/retry | `/agents → Workflows`, or `Enter` on the workflow row |
| Transcript file | Everything, after the fact | Path in the completion notification |

## Reading the status line

```text
⠹ Explore  find auth files · ↻3≤30 · 3 tool uses · 12.4k token (8%) · 4.1s
```

| Field | Meaning | When to act |
|---|---|---|
| `↻N≤M` | Turns used / limit | Approaching `M` means it will be steered to wrap up and answer partially |
| tool uses | Tool calls so far | High with low progress = thrash |
| `NN%` | Context-window utilization | Above ~85% the agent is losing the start of its task |
| `⇊N` | Compactions so far | Any compaction means detail has been summarized away |
| elapsed | Wall time | Only matters against what else is waiting |

Statuses on completion: `completed` (`✓`), `steered` (`✓` yellow — hit the turn
limit and wrapped up), `aborted` (`✗` — blew the grace period), `stopped` (`■`).
The last three are explicitly partial.

## Do not poll

Background agents notify you when they finish. Sleeping, re-calling
`get_subagent_result`, or narrating "let me check on it" burns turns and tokens
and changes nothing.

`get_subagent_result` is for when you actually need the full text — the
completion notification carries only a preview. `wait: true` blocks; cancelling
that wait (Esc) stops only the wait, not the agent, and the notification still
arrives.

The corollary: between launching an agent and its notification, **you know
nothing about its results**. Do not write them, predict them, or plan around
them. If asked, report that it is still running.

## Steering

`steer_subagent({ agent_id, message })`, or `@handle message` at the prompt, or
`Enter` in the conversation viewer. The message is injected after the current
tool call completes and lands as a user turn in the agent's conversation.

Steer when:

- the agent is working from a premise you now know is wrong;
- you learned a constraint it needs (a file it must not touch, a test it must run);
- it is going broader than the task needs and you want it bounded;
- it asked something implicitly and you can answer it.

Do not steer to add a second task — spawn a second agent. A steered agent carries
both jobs in one context and does the second one worse.

Steering is far cheaper than restarting: the agent's accumulated context is the
expensive part of the run. A restart re-pays all of it.

A steer is accepted even when the agent is queued (`subagents:steered` fires
either way); it is delivered when the agent starts.

## Stopping

`x` twice in `/agents → Running agents` or in the conversation viewer. A global
Esc cannot unambiguously target a background agent, which is why the explicit key
exists.

Stop when the premise is dead, not when the agent is slow. A stopped agent
reports whatever partial output it had, labelled incomplete — so a stop is a way
to harvest, not only to cancel.

Stopping a workflow is `x` in the inspector; `p` pauses instead, which stops
*starting* new agents while letting running ones finish (killing a turn mid-flight
throws away everything it spent). Held time is subtracted from the run clock.

## Resuming

A finished agent is a resumable conversation, not a corpse.

- `@handle message` resumes it in the background, continuing where it left off —
  even long after its in-memory record was evicted, as long as `rememberAgents`
  was on (the default).
- `Agent({ resume: "<id or handle>", prompt })` does the same from a tool call.
  It resumes detached by default; `run_in_background: false` blocks.
- Only the *definition* is re-resolved, so a resumed agent runs under the agent
  type's current frontmatter. If the type was deleted or disabled, the resume is
  refused rather than silently falling back.
- `resume` cannot be combined with `branch` or with `schedule`.

Resume when you want the agent's context: a follow-up question, a correction, a
second pass over the same material. Spawn fresh when the task is different — a
resumed agent drags its whole previous context into the new job.

## Handles and addressing

Every top-level agent gets a handle: the type lowercased, numbered on collision
(`explore`, `explore-2`), plus any `name` you gave it at spawn. Names are
additive — the type handle keeps working.

`@handle` covers the whole lifecycle: message it while running, resume it when
finished, reopen it from disk later, start it if it never ran. Only a *leading*
mention is routed; `@main` forces text back to the main model; a bare handle with
no message is not a send.

`steer_subagent` and `get_subagent_result` accept handles too, so you and the
human address agents the same way.

Nested children are not addressable from the top level, and only their owning
agent can steer or collect them.

## Notifications and join modes

| Mode | Behavior | Use when |
|---|---|---|
| `smart` (default) | 2+ agents spawned in one turn are consolidated into one notification | The fan-out is a unit and you want one synthesis point |
| `async` | Each agent notifies separately | Results need handling as they land |
| `group` | Force grouping even for one agent | You know more agents are about to follow |

Grouped notifications wait up to 30s after the first completion, then send a
partial notification with what is done and re-batch stragglers on a 15s window.

The model receives structured `<task-notification>` XML; the human sees a themed
box with the transcript path. Batch totals are printed when several land
together.

## Queueing and concurrency

`maxConcurrent` (default 10) bounds background agents; the rest queue and start
as slots free. Queued agents appear in `/agents → Running agents` as `queued` and
can be stopped there. A fan-out larger than the limit is fine — it drains.

Foreground agents have their own pool (`maxConcurrentForeground`, default
unlimited), because a foreground agent blocks its parent anyway.

Nested children and workflow agents are outside both pools; a workflow bounds
itself at `max(1, min(16, cpus - 2))`.

## Supervising a workflow

The inspector (`/agents → Workflows`) gives five keys:

| Key | Effect |
|---|---|
| `x` | Stop the run |
| `p` | Pause/resume — no new agents start, running ones finish |
| `s` | Skip the selected agent: its `agent()` call returns `null` in the script |
| `r` | Retry the selected agent: the child is stopped and the same call re-runs |
| `c` | Open the selected agent's conversation (works after it settles) |

`s` and `r` change the run, not the view. A skipped agent puts a `null` into the
data the script is assembling — exactly as a terminal failure would — so a script
that does not filter will carry the hole forward.

A workflow's own agents do not appear in FleetView, the widget, `/agents` or
`@handle` resolution; the run reports for them, and `c` is the way into a child's
conversation.

## Transcripts

Every agent streams its full conversation to
`<artifact root>/<project>/<session>/tasks/<agent-id>.output` (JSON lines) unless
`output_transcript` is off. The completion notification prints the path.

Read the transcript, not just the answer, when:

- the result is surprising in either direction;
- you are tuning the agent type (see the authoring skill's evaluation reference);
- two agents disagree;
- a run cost far more than expected.

In the viewer, `Tab` toggles Steps/Raw, `o` opens full retained output, `t`
focuses the task, `m` cycles markdown rendering, and `?` lists keys.
