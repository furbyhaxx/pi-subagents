# Evaluating and tuning an agent type

An agent definition runs many times, on tasks you will not see. One good demo run
proves nothing. This is how to get evidence cheaply.

## Contents

- [What to measure](#what-to-measure)
- [The loop](#the-loop)
- [Building the task set](#building-the-task-set)
- [Reading a transcript](#reading-a-transcript)
- [A/B comparing two versions](#ab-comparing-two-versions)
- [Turning on the instrumentation](#turning-on-the-instrumentation)
- [Interpreting common results](#interpreting-common-results)
- [Optimizing the description](#optimizing-the-description)

## What to measure

| Signal | Where it comes from | What it tells you |
|---|---|---|
| Task success | Your own check of the output against the acceptance criterion | The only signal that matters |
| Turns (`↻N`) | Widget, `/agents`, completion notification | Wasted motion; a turn is a round trip |
| Tool uses | Same | Re-reading, failed tool attempts, thrash |
| Tokens | Same | Context cost; compare against the baseline agent |
| Context utilization `(NN%)` and `⇊N` compactions | Widget | The agent is being given too much, or reading too much |
| Wall time | Completion notification | Matters mainly for foreground and for fan-outs |
| Estimated cost | Enable `showCost` | Whether a stronger model is actually paying for itself |
| Status | `completed` / `steered` / `aborted` / `stopped` | `steered` means it hit `max_turns` and wrapped up; `aborted` means it blew through the grace period |

A `steered` result is not a pass. It means the agent ran out of turns and
produced whatever it had. Either the task was too big for one agent (split it) or
`max_turns` is too low.

## The loop

1. **Write the task set** — two or three realistic tasks, before touching the
   file. See below.
2. **Baseline it.** Run the same tasks against what the agent is supposed to
   replace: usually `general-purpose` with the same prompt, or the previous
   version of this agent file. Copy the old file somewhere first if you are
   editing in place.
3. **Run both**, in the background, in the same turn, so they finish together
   and the comparison is not coloured by what you learned in between.
4. **Read the transcripts**, not just the answers.
5. **Change one thing.** Prefer deleting a rule over adding one.
6. **Re-run the same task set.** A change that helps task 1 and breaks task 2 is
   not an improvement.
7. Stop when the remaining complaints are about the task, not the agent.

## Building the task set

Three tasks, deliberately chosen:

- **The centre of the job** — what the agent will be asked 80% of the time.
- **The edge** — a case that is nearly out of scope. This is where an
  over-specified prompt fails and where a vague one wanders.
- **The refusal** — something it should decline, escalate, or report as
  untestable. An agent with no graceful failure mode fabricates.

Write them as a caller actually would: concrete paths, real file names, the
ambiguity a real request has. A sanitized task tests nothing.

## Reading a transcript

Transcripts land at
`<agent dir>/sessions/<project>/<session>/tasks/<agent-id>.output` (JSON lines),
and the completion notification prints the path. Interactively, open the agent
from `/agents → Running agents` or FleetView and press `Enter`; `Tab` switches
Steps and Raw, `o` opens full retained output.

What to look for, in order:

1. **The first three turns.** If the agent spends them working out what it was
   asked, the brief or the role section is underspecified.
2. **Repeated reads of the same file.** It is not holding context — usually a
   sign the task is too large or the output requirements are scattered.
3. **Tool calls that failed.** An agent reaching for `write` it does not have, or
   `bash cat` when it has `read`, is a scoping or prompt mismatch.
4. **Narration.** Long "here is my plan" messages between tool calls mean the
   prompt asked for process visibility it does not need.
5. **The last turn.** Did it answer in the shape the Output section asked for? If
   not, the shape is either unclear or arrived too late in the prompt.

## A/B comparing two versions

Two rules make the comparison worth anything:

- **Same tasks, same wording.** Any change to the prompt invalidates the delta.
- **Blind the judgement where you can.** If you ask a third agent which output is
  better, do not tell it which is the new version — and give it the acceptance
  criterion, not "which is better".

For a definition you intend to ship widely, run each task more than once. Model
output varies; a single run difference is noise, especially on turn counts.

## Turning on the instrumentation

```jsonc
// .pi/subagents.json
{
  "showModel": true,      // widget names the model and thinking level actually used
  "showCost": true,       // estimated cost beside token counts
  "reportUsage": true,    // fold subagent spend into this session's /cost
  "outputTranscript": true
}
```

`showModel` is the one that catches configuration bugs: it reports what the run
*actually* used after pi resolved defaults and clamped thinking, and shows the
request beside it when they differ (`thinking: low (asked max)`). The
conversation viewer's `↳` row spells out the canonical `provider/model-id`.

For a fan-out comparison, `SubagentWorkflow` is the cheap harness: one script
that runs the same task list against two `agentType`s and returns both results.
Use `gate:` when success is checkable by a command — a test suite is a far
stronger signal than another model's opinion.

## Interpreting common results

| Observation | Likely cause | Try |
|---|---|---|
| New agent is slower and no better | Prompt added process, not capability | Delete the Method section and re-run |
| Great on task 1, wanders on task 2 | Prompt encodes the first task | Move task-specific content into the caller's brief |
| Hits `max_turns` (`steered`) on the normal case | Task too big, or output requirements force re-reading | Split the task, or raise the limit deliberately |
| Cheap model succeeds as often as the strong one | The job is mechanical | Pin the cheap model; keep the strong one as the second fallback candidate |
| Strong model wins only on the edge case | Route by task, not by agent | Two agent types, or let the caller pass `model` |
| Agent answers in prose when you asked for a shape | Output section too late or too vague | Put the literal template in the prompt; for scripts, use `schema` |
| High token count, low tool count | `inherit_context`, preloaded skills, or an `append` parent prompt | Check whether it needs all three |

## Optimizing the description

The `description` decides whether the agent is ever *selected*. Test it
separately from behavior: write ten realistic requests that should route here and
ten near-misses that should not (adjacent jobs, shared keywords, the same file
types used for a different purpose), then check where they actually go.

Near-misses are the valuable half. "Write a fibonacci function" is not a useful
negative test for a code-review agent; "look over this PR and tell me if the
migration is safe to run twice" is.

The failure mode to watch for is under-triggering: descriptions that read as
titles get skipped in favour of `general-purpose`. Stating the trigger explicitly
("use this whenever a diff or a set of changed files needs reviewing, even if the
request does not say 'review'") fixes more misrouting than any body edit.
